import { createContext } from 'react';
import type { PersonalPresentation } from '@rally/contracts';
export const MemberPresentationContext = createContext<ReadonlyMap<string, PersonalPresentation>>(new Map());
