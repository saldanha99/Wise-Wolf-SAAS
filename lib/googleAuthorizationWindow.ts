/** Reserve a tab during the click, before the asynchronous OAuth request. */
export async function openGoogleAuthorization<T extends { authorization_url?: string }>(
  prepare: () => Promise<T>,
): Promise<{ result: T; opened: boolean }> {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const result = await prepare();
    const url = new URL(result.authorization_url || '');
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
      throw new Error('Não foi possível abrir o login do Google. Tente novamente.');
    }
    if (tab && !tab.closed) {
      tab.location.href = url.href;
      return { result, opened: true };
    }
    return { result, opened: false };
  } catch (error) {
    tab?.close();
    throw error;
  }
}
