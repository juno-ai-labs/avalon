/**
 * The base every migrated Durable Object in this Worker extends.
 *
 * Two things live here, and they are two halves of one idea. A Durable Object's
 * schema is applied by *waking it*: the migration runs in the constructor and
 * nowhere else. So the object is the only place that can say what schema it is
 * on, and it is also the only place that can be asked to move to a new one.
 * Both of those were previously per-class arrangements — four constructors each
 * repeating the same `withMigrationReport` call, and no way at all to ask an
 * object to catch up — which meant a fifth class could be added that reported
 * nothing and could not be reached.
 *
 * A subclass declares its schema once, in `migrationPlan`, and says when that
 * schema is ready, in `migrationsReady`. In exchange it gets the report to the
 * tracker and the `forceMigration` RPC without writing either, and it cannot
 * silently opt out of them: both members are abstract, so a new Durable Object
 * class that does not implement them does not compile.
 *
 * `docs/durable-object-migration-tracking.md` owns the subsystem on both sides
 * of this file — the report going out, and the command coming in.
 */
import type { DurableObjectMigrationCommand } from "@rally/contracts/durable-object-migrations";
import { DurableObject } from "cloudflare:workers";

import {
  beginConstructorWindow,
  beginObjectConstruction,
  endConstructorWindow,
  endObjectConstruction,
} from "./object-retirement";

import type { Env } from "../env";
import { inDurableObjectPhase } from "../observability/tracing";
import {
  latestMigrationVersion,
  reportForcedMigration,
  withMigrationReport,
  type ForcedMigrationOutcome,
} from "./migration-reporting";
import type { DurableObjectSqliteMigration } from "./sqlite-migrations";

/**
 * One class's schema, in the one place both the report and the forced migration
 * read it from.
 *
 * Returned by a method rather than held in a field because it is read during
 * the subclass's own constructor, before its fields are assigned. Every
 * implementation answers with module constants for that reason.
 */
export interface DurableObjectMigrationPlan {
  /** The migration runner's component key — the namespace of the versions. */
  component: string;
  /** The class name as bound in the regional Wrangler file. */
  className: string;
  /** The full migration list the running build ships for this component. */
  migrations: readonly DurableObjectSqliteMigration[];
}

export abstract class MigratableDurableObject<TEnv extends Env = Env>
  extends DurableObject<TEnv> {
  private readonly constructorStartedAt = Date.now();

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
    // Opened here, before any subclass constructor body runs, because a
    // subclass must call `super()` first. Everything construction touches is
    // therefore inside the window — including the methods a constructor calls
    // directly, which is the class of thing that cannot be enumerated safely.
    // Three were found one at a time before this moved: `migrationsReady`,
    // `startRuntimeRecovery`, and `wakeMainSubstream`.
    //
    // It is safe to open here for the reason it was safe before: nothing
    // external is admitted until the constructor's `blockConcurrencyWhile`
    // resolves, so no product call can take it. It closes when that promise
    // settles, in `initializeDurableObject` below.
    beginConstructorWindow(this);
  }
  /** This class's schema: its component key, its class name, its migrations. */
  protected abstract migrationPlan(): DurableObjectMigrationPlan;

  /**
   * Resolves once this object's constructor has finished applying its schema.
   *
   * Every class already holds this promise — it is the `blockConcurrencyWhile`
   * its constructor stores — and every entry point already awaits it. Naming it
   * here is what lets the base await the migration without knowing how the
   * subclass runs it, which is the difference between an `AgentLoopDO`, whose
   * schema is applied by a store's constructor, and the three that call the
   * runner directly.
   */
  protected abstract migrationsReady(): Promise<void>;

  /**
   * The constructor's input gate, instrumented once for every migratable class.
   * Subclasses use this instead of calling `blockConcurrencyWhile` directly so
   * a newly-added object cannot silently recreate the cold-wake blind spot.
   */
  protected initializeDurableObject(run: () => Promise<void>): Promise<void> {
    // Re-opened for this call's own duration, not only for the constructor's.
    // `run` is a closure over the raw instance, so nothing the gate does to a
    // receiver can reach inside it — the window is the only thing that can.
    // The justification is the same one that makes the window safe at all:
    // `blockConcurrencyWhile` admits no other event, so there is no window a
    // product call could take, wherever this is called from.
    beginObjectConstruction(this);
    const plan = this.migrationPlan();
    return this.ctx.blockConcurrencyWhile(() => inDurableObjectPhase(
      this.env,
      "initialize",
      {
        component: plan.component,
        className: plan.className,
        latestVersion: latestMigrationVersion(plan.migrations),
        startedAt: this.constructorStartedAt,
      },
      run,
    )).finally(() => {
      // Closed whether construction succeeded or threw. A half-built object
      // that stayed inside the window would be a permanently ungated one —
      // which is also why every gated class must reach this method from its
      // constructor. The refusal tests are what prove they do: if the window
      // leaked, a retired object would answer a product call.
      endObjectConstruction(this);
      // And the constructor's own opening, which the first of these to settle
      // is what releases. Idempotent, so a second call here changes nothing.
      endConstructorWindow(this);
    });
  }

  /**
   * Milliseconds since this instance's constructor began.
   *
   * Uses workerd's clock, which advances across I/O rather than during
   * synchronous work. A small age suggests a recently created instance; it
   * does not identify which concurrent call woke it or measure CPU time.
   */
  protected instanceAgeMs(): number {
    return Math.max(0, Date.now() - this.constructorStartedAt);
  }

  /**
   * Apply this object's schema and tell the tracker what happened.
   *
   * The one call every constructor makes, in place of its own
   * `withMigrationReport`. `apply` stays synchronous and stays the first thing
   * that runs, so a broken schema still fails construction rather than being
   * observed half-applied, and its value is returned untouched for the call
   * site that builds something out of it.
   */
  protected applyMigrations<T>(apply: () => T): Promise<T> {
    const plan = this.migrationPlan();
    return withMigrationReport({
      state: this.ctx,
      env: this.env,
      component: plan.component,
      className: plan.className,
      latestVersion: latestMigrationVersion(plan.migrations),
    }, apply);
  }

  /**
   * Move this object onto the running build's schema, because an operator asked.
   *
   * The RPC the forced-migration queue consumer calls, one object per message.
   * The awaited `migrationsReady()` *is* the migration: reaching this method at
   * all means the object woke on the current build, and waking is what applies
   * the schema. There is deliberately no second application of the runner
   * behind it — that would be a different code path to the one every other wake
   * takes, exercised only by an operator, on the objects least able to afford a
   * surprise.
   *
   * A migration that throws throws here too, out through the consumer, which
   * retries the message and eventually dead-letters it. That is the outcome to
   * want: the object also reports its failure on the way past, so the tracker
   * shows the break, and the dead-letter queue counts how many objects are in
   * it without anybody building a tally.
   *
   * The two identity checks are not defence against a hostile caller — a queue
   * has no public address and only a binding in this account can write to it.
   * They catch a wiring mistake: a command routed through the wrong namespace
   * binding would otherwise create an empty object and report it as healthy.
   */
  async forceMigration(command: DurableObjectMigrationCommand): Promise<ForcedMigrationOutcome> {
    const plan = this.migrationPlan();
    if (command.className !== plan.className) {
      throw new Error(
        `durable_object_migration_command_class_mismatch:${command.className}:${plan.className}`,
      );
    }
    const objectId = this.ctx.id.toString();
    if (command.objectId !== objectId) {
      throw new Error(`durable_object_migration_command_object_mismatch:${command.objectId}`);
    }
    await this.migrationsReady();
    return reportForcedMigration({
      state: this.ctx,
      env: this.env,
      component: plan.component,
      className: plan.className,
      latestVersion: latestMigrationVersion(plan.migrations),
    }, command.objectName);
  }
}
