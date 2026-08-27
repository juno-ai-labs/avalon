function propertyName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return null;
}

function objectPropertyNames(node) {
  if (!node || node.type !== "ObjectExpression") return null;
  const names = new Set();
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed) continue;
    if (property.key.type === "Identifier") names.add(property.key.name);
    else if (property.key.type === "Literal" && typeof property.key.value === "string") names.add(property.key.value);
  }
  return names;
}

export const noDirectOpenRouterClientRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep API inference behind the structured-inference gateway." },
    schema: [],
    messages: {
      directClient: "Do not construct OpenRouterClient in an API feature module. Use runStructuredInference() so routing, cancellation, and diagnostics cannot be bypassed.",
    },
  },
  create(context) {
    const bindings = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@rally/agent-harness") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier"
            && ((specifier.imported.type === "Identifier" && specifier.imported.name === "OpenRouterClient")
              || (specifier.imported.type === "Literal" && specifier.imported.value === "OpenRouterClient"))
          ) {
            bindings.add(specifier.local.name);
          }
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && bindings.has(node.callee.name)) {
          context.report({ node, messageId: "directClient" });
        }
      },
    };
  },
};

const MODEL_ENV_NAMES = new Set([
  "OPENROUTER_PRIMARY_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "OPENROUTER_CLASSIFIER_MODEL",
  "OPENROUTER_STRUCTURED_MODEL",
  "OPENROUTER_AUTOMATION_MODEL",
]);

export const noDirectModelEnvReadRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep model selection behind the per-agent flag resolver." },
    schema: [],
    messages: {
      directModelEnv: "Read model configuration through resolveAgentModelRouting(); direct {{name}} access bypasses per-agent flags and rollout bucketing.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (name && MODEL_ENV_NAMES.has(name)) {
          context.report({ node, messageId: "directModelEnv", data: { name } });
        }
      },
      Property(node) {
        if (node.parent?.type !== "ObjectPattern" || node.computed) return;
        const name = node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "Literal" && typeof node.key.value === "string"
            ? node.key.value
            : null;
        if (name && MODEL_ENV_NAMES.has(name)) {
          context.report({ node, messageId: "directModelEnv", data: { name } });
        }
      },
    };
  },
};

function requiredInferenceOptionRule(option, methods, message) {
  return {
    meta: {
      type: "problem",
      docs: { description: message },
      schema: [],
      messages: { missing: message },
    },
    create(context) {
      return {
        CallExpression(node) {
          const method = propertyName(node.callee);
          if (!method || !methods.has(method)) return;
          const properties = objectPropertyNames(node.arguments[0]);
          if (!properties || !properties.has(option)) context.report({ node, messageId: "missing" });
        },
      };
    },
  };
}

export const requireInferenceSignalRule = requiredInferenceOptionRule(
  "signal",
  new Set(["stream", "structured"]),
  "Inference calls must pass an AbortSignal so a stalled provider cannot outlive its owning operation.",
);

export const requireInferenceDiagnosticsRule = requiredInferenceOptionRule(
  "onDiagnostic",
  new Set(["structured"]),
  "Structured inference must pass onDiagnostic so provider and validation failures remain observable.",
);

const TICKET_METHODS = new Set([
  "getSocketTicket",
  "getWorkspaceSocketTicket",
  "getWorkstreamControlSocketTicket",
  "getBlockDashboardBlockSocketTicket",
  "getRealtimeTranscriptionTicket",
  "getTranscriptionSocketTicket",
]);

function unwrapAwait(node) {
  return node?.type === "AwaitExpression" ? node.argument : node;
}

export const requireWebSocketTicketRule = {
  meta: {
    type: "problem",
    docs: { description: "Require renderer WebSockets to use a URL returned by an authenticated ticket endpoint." },
    schema: [],
    messages: {
      ticket: "Renderer WebSockets must use `<ticket>.url`, where the ticket comes from an approved API socket-ticket method.",
    },
  },
  create(context) {
    const ticketBindings = new Set();
    const realtimeSocketBindings = new Set();
    const realtimeSocketNamespaces = new Set();
    const sourceCode = context.sourceCode;
    const bindingFor = (identifier) => {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const binding = scope.set.get(identifier.name);
        if (binding) return binding;
        scope = scope.upper;
      }
      return null;
    };
    const isRealtimeSocketFactory = (callee) => {
      if (callee.type === "Identifier") {
        const binding = bindingFor(callee);
        return binding
          ? realtimeSocketBindings.has(binding)
          : callee.name === "createRealtimeSocket";
      }
      return callee.type === "MemberExpression"
        && propertyName(callee) === "createRealtimeSocket"
        && callee.object.type === "Identifier"
        && realtimeSocketNamespaces.has(bindingFor(callee.object));
    };
    const isTicketUrl = (argument) => (
      argument?.type === "MemberExpression"
      && propertyName(argument) === "url"
      && argument.object.type === "Identifier"
      && ticketBindings.has(argument.object.name)
    );
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string" || !/(?:^|\/)realtime-socket$/u.test(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          const binding = sourceCode.getDeclaredVariables(specifier)[0];
          if (!binding) continue;
          if (specifier.type === "ImportNamespaceSpecifier") {
            realtimeSocketNamespaces.add(binding);
          } else if (
            specifier.type === "ImportSpecifier"
            && ((specifier.imported.type === "Identifier" && specifier.imported.name === "createRealtimeSocket")
              || (specifier.imported.type === "Literal" && specifier.imported.value === "createRealtimeSocket"))
          ) {
            realtimeSocketBindings.add(binding);
          }
        }
      },
      VariableDeclarator(node) {
        const init = unwrapAwait(node.init);
        if (node.id.type === "Identifier" && init?.type === "CallExpression") {
          const method = propertyName(init.callee);
          if (method && TICKET_METHODS.has(method)) ticketBindings.add(node.id.name);
          return;
        }
        if (
          node.id.type !== "ArrayPattern"
          || init?.type !== "CallExpression"
          || propertyName(init.callee) !== "all"
          || init.arguments[0]?.type !== "ArrayExpression"
        ) return;
        for (const [index, element] of node.id.elements.entries()) {
          const source = init.arguments[0].elements[index];
          if (element?.type !== "Identifier" || source?.type !== "CallExpression") continue;
          const method = propertyName(source.callee);
          if (method && TICKET_METHODS.has(method)) ticketBindings.add(element.name);
        }
      },
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "WebSocket") return;
        if (isTicketUrl(node.arguments[0])) return;
        context.report({ node, messageId: "ticket" });
      },
      CallExpression(node) {
        if (!isRealtimeSocketFactory(node.callee)) return;
        if (isTicketUrl(node.arguments[1])) return;
        context.report({ node, messageId: "ticket" });
      },
    };
  },
};
