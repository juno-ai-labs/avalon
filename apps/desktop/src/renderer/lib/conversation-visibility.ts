import { createContext } from 'react';

/** Hosts may keep a conversation mounted while temporarily hiding its pane. */
export const ConversationVisibilityContext = createContext(true);
