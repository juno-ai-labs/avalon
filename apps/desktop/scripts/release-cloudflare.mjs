export function cloudflareErrorCodes(body) {
  if (!Array.isArray(body?.errors)) return 'none';
  const codes = body.errors
    .map((error) => error?.code)
    .filter((code) => Number.isSafeInteger(code));
  return codes.length > 0 ? codes.join(',') : 'none';
}
