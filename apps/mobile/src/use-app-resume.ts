import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { appResumeListener } from './app-resume';

export function useAppResume(resume: () => void) {
  const current = useRef(resume);
  current.current = resume;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', appResumeListener(AppState.currentState ?? null, () => current.current()));
    return () => subscription.remove();
  }, []);
}
