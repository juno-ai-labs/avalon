import { connectorOffering, offeringCapabilities } from './connector-offerings';

/**
 * The capability set a personal Slack connection asks for.
 *
 * Three surfaces now start the same authorization: the **Connect for me**
 * button in Settings, a Slack connector card in a work-stream transcript, and
 * the Slack account link, which continues straight into it so that one click in
 * Slack both links the identity and connects personal Slack. Two copies of this
 * list would drift, and the drift is invisible — a member would silently get a
 * narrower grant depending on which button they happened to press.
 *
 * It is read from the shared connector registry rather than written out here,
 * which is what makes that true for the two surfaces that never import this
 * constant. Kept as a named export because the Slack link is the one caller
 * that is not choosing an offering at all: it already knows which connection it
 * is finishing.
 */
export const SLACK_PERSONAL_CAPABILITIES: readonly string[] =
  offeringCapabilities(connectorOffering('slack'), 'you');
