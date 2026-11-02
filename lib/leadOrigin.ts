export function leadOriginNotes(notes = '', locationUrl?: string, referrer?: string): string {
  try {
    const url = new URL(locationUrl ?? window.location.href);
    const data: Record<string, string> = { landing_path: url.pathname, last_landing_path: url.pathname };
    for (const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']) {
      const value = url.searchParams.get(key); if(value) data[key] = value.slice(0,180);
    }
    for (const key of ['gclid','wbraid','gbraid','fbclid']) if(url.searchParams.has(key)) data[key] = 'present';
    const ref = referrer ?? document.referrer;
    if(ref) { const host = new URL(ref).hostname; if(!/(^|\.)wisewolflanguage\.com\.br$/.test(host)) data.referrer_host = host; }
    return `${notes.slice(0,2500)}\nOrigem: ${JSON.stringify(data)}`;
  } catch { return notes; }
}
