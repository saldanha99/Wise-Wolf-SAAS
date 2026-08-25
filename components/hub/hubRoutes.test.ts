import { describe, expect, it } from 'vitest';
import {
  hubCanonicalUrl,
  hubMarketingPath,
  isHubMarketingHost,
  resolveHubMarketingPage,
  resolveSystemAppUrl,
} from './hubRoutes';

describe('Hub marketing routes', () => {
  it('serves the Hub at the root of its dedicated domain', () => {
    expect(isHubMarketingHost('hub.wisewolflanguage.com.br')).toBe(true);
    expect(isHubMarketingHost('hub.wiseowllanguage.com.br')).toBe(false);
    expect(hubMarketingPath('overview', 'hub.wisewolflanguage.com.br')).toBe('/');
    expect(hubMarketingPath('teachers', 'hub.wisewolflanguage.com.br')).toBe('/professores');
    expect(hubMarketingPath('schools', 'hub.wisewolflanguage.com.br')).toBe('/escolas');
    expect(hubMarketingPath('library', 'hub.wisewolflanguage.com.br')).toBe('/biblioteca');
    expect(hubMarketingPath('terms', 'hub.wisewolflanguage.com.br')).toBe('/termos');
    expect(hubMarketingPath('privacy', 'hub.wisewolflanguage.com.br')).toBe('/privacidade');
    expect(resolveHubMarketingPage('/professores', 'hub.wisewolflanguage.com.br')).toBe('teachers');
    expect(resolveHubMarketingPage('/escolas/', 'hub.wisewolflanguage.com.br')).toBe('schools');
    expect(resolveHubMarketingPage('/educador-ia', 'hub.wisewolflanguage.com.br')).toBe('educator-ai');
    expect(resolveHubMarketingPage('/termos', 'hub.wisewolflanguage.com.br')).toBe('terms');
    expect(resolveHubMarketingPage('/privacidade', 'hub.wisewolflanguage.com.br')).toBe('privacy');
  });

  it('keeps compatible paths inside the school-system host', () => {
    expect(hubMarketingPath('overview', 'system.wisewolflanguage.com.br')).toBe('/hub');
    expect(hubMarketingPath('teachers', 'system.wisewolflanguage.com.br')).toBe('/hub/professores');
    expect(hubMarketingPath('schools', 'system.wisewolflanguage.com.br')).toBe('/hub/escolas');
    expect(hubMarketingPath('school-os', 'system.wisewolflanguage.com.br')).toBe('/hub/saas-escolar');
    expect(hubMarketingPath('terms', 'system.wisewolflanguage.com.br')).toBe('/hub/termos');
    expect(hubMarketingPath('privacy', 'system.wisewolflanguage.com.br')).toBe('/hub/privacidade');
    expect(resolveHubMarketingPage('/hub/professores', 'system.wisewolflanguage.com.br')).toBe('teachers');
    expect(resolveHubMarketingPage('/hub/escolas/', 'system.wisewolflanguage.com.br')).toBe('schools');
    expect(resolveHubMarketingPage('/hub/wolfie', 'system.wisewolflanguage.com.br')).toBe('wolfie');
    expect(resolveHubMarketingPage('/hub/termos', 'system.wisewolflanguage.com.br')).toBe('terms');
    expect(resolveHubMarketingPage('/hub/privacidade', 'system.wisewolflanguage.com.br')).toBe('privacy');
  });

  it('does not treat unknown Hub paths as marketing pages', () => {
    expect(resolveHubMarketingPage('/hub/conta', 'system.wisewolflanguage.com.br')).toBeNull();
  });

  it('consolidates canonical URLs on the dedicated Hub host', () => {
    expect(hubCanonicalUrl('overview', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/');
    expect(hubCanonicalUrl('teachers', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/professores');
    expect(hubCanonicalUrl('schools', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/escolas');
    expect(hubCanonicalUrl('educator-ai', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/educador-ia');
    expect(hubCanonicalUrl('terms', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/termos');
    expect(hubCanonicalUrl('privacy', 'system.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/privacidade');
    expect(hubCanonicalUrl('overview', 'hub.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/');
    expect(hubCanonicalUrl('teachers', 'hub.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/professores');
    expect(hubCanonicalUrl('schools', 'hub.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/escolas');
    expect(hubCanonicalUrl('educator-ai', 'hub.wisewolflanguage.com.br')).toBe('https://hub.wisewolflanguage.com.br/educador-ia');
  });

  it('keeps system destinations outside the dedicated Hub host', () => {
    expect(resolveSystemAppUrl('/new-saas')).toBe('https://system.wisewolflanguage.com.br/new-saas');
    expect(resolveSystemAppUrl('https://wisewolflanguage.com.br/demonstracao')).toBe('https://wisewolflanguage.com.br/demonstracao');
    expect(resolveSystemAppUrl('https://agenda.example.com/demo', '/new-saas')).toBe('https://system.wisewolflanguage.com.br/new-saas');
    expect(resolveSystemAppUrl('http://system.wisewolflanguage.com.br/new-saas', '/new-saas')).toBe('https://system.wisewolflanguage.com.br/new-saas');
    expect(resolveSystemAppUrl('javascript:alert(1)', '/new-saas')).toBe('https://system.wisewolflanguage.com.br/new-saas');
    expect(resolveSystemAppUrl('javascript:alert(1)', 'https://malicious.example.com')).toBe('https://system.wisewolflanguage.com.br/');
  });
});
