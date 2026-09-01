interface IdentityCredential {
  accessToken: string;
}

export async function requestWithOnboardingIdentity<TIdentity extends IdentityCredential>({
  load,
  refresh,
  fetch,
}: {
  load: () => Promise<TIdentity>;
  refresh: (identity: TIdentity) => Promise<TIdentity>;
  fetch: (identity: TIdentity) => Promise<Response>;
}): Promise<{ identity: TIdentity; response: Response }> {
  let identity = await load();
  let response = await fetch(identity);
  if (response.status === 401) {
    identity = await refresh(identity);
    response = await fetch(identity);
  }
  return { identity, response };
}
