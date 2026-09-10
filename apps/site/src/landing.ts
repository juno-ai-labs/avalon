import { accessChallenge } from './access-challenge';
import { accessCopy } from './access-copy';

const form = document.querySelector<HTMLFormElement>('#access-request');
const email = document.querySelector<HTMLInputElement>('#access-email');
const button = document.querySelector<HTMLButtonElement>('#access-submit');
const status = document.querySelector<HTMLElement>('#access-status');
const apiOrigin = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:8787' : 'https://api.rallywith.ai';

if (form && email && button && status) {
  // The button starts disabled so no-JavaScript browsers never submit an email
  // into a URL or a static host that cannot process it.
  let pending = false;
  let token: string | null = null;
  const challenge = accessChallenge((value) => { token = value; button.disabled = pending || !value; }, () => {
    status.dataset.state = 'error'; status.textContent = 'Verification is unavailable. Please refresh and try again.';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || !token || !form.reportValidity()) return;
    pending = true; button.disabled = true; email.readOnly = true;
    button.textContent = accessCopy.pending; status.textContent = ''; delete status.dataset.state;
    void (async () => {
      let failure = accessCopy.failure;
      try {
        const response = await fetch(`${apiOrigin}/access/requests`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.value.trim(), turnstileToken: token }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          const saved = body?.error?.code === 'access_email_unavailable' || body?.error?.code === 'access_email_failed';
          failure = body?.error?.code === 'access_email_review_required' ? accessCopy.reviewRequired
            : body?.error?.code === 'access_email_rejected' ? accessCopy.rejected
            : saved ? accessCopy.savedFailure : accessCopy.failure;
          throw new Error('Request failed');
        }
        form.hidden = true;
        const widget = document.querySelector<HTMLElement>('#access-challenge');
        if (widget) widget.hidden = true;
        status.dataset.state = 'success';
        status.textContent = accessCopy.success;
        status.focus();
      } catch {
        status.dataset.state = 'error';
        status.textContent = failure;
      } finally {
        pending = false; email.readOnly = false;
        if (!form.hidden) challenge.reset();
        button.disabled = !token;
        button.textContent = accessCopy.button;
      }
    })();
  });
}
