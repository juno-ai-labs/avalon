import { createContext, useContext, type PropsWithChildren } from 'react';

const ConversationAdmissionContext = createContext(true);

/** Mount and warm a conversation without treating pending onboarding as a visit. */
export function ConversationAdmissionProvider({ allowed, children }: PropsWithChildren<{ allowed: boolean }>): React.JSX.Element {
  const parentAllowed = useContext(ConversationAdmissionContext);
  return <ConversationAdmissionContext.Provider value={parentAllowed && allowed}>{children}</ConversationAdmissionContext.Provider>;
}

export function useConversationAdmission(): boolean {
  return useContext(ConversationAdmissionContext);
}
