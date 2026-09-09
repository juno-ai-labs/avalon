import { DownloadGrantTokenSchema } from '@rally/contracts/private-access';

const parameters = new URLSearchParams(location.hash.slice(1));
const parsed = DownloadGrantTokenSchema.safeParse(parameters.get('token'));
window.history.replaceState(null, document.title, location.pathname);
const form = document.querySelector<HTMLFormElement>('#download-form');
const input = document.querySelector<HTMLInputElement>('#download-token');
if (form && input && parsed.success && [...parameters].length === 1) {
  input.value = parsed.data;
  const apiOrigin = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8787' : 'https://api.rallywith.ai';
  form.action = `${apiOrigin}/access/downloads/redeem`;
  form.hidden = false;
} else {
  document.querySelector('#download-error')?.removeAttribute('hidden');
}
