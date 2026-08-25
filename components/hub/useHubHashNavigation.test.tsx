import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToHubHashTarget, useHubHashNavigation } from './useHubHashNavigation';

const scrollIntoView = vi.fn();

const HashNavigationHarness: React.FC<{
  ready: boolean;
  children: React.ReactNode;
}> = ({ ready, children }) => {
  useHubHashNavigation(ready, 'teachers');
  return children;
};

const setReducedMotion = (matches: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
};

describe('Hub hash navigation', () => {
  beforeEach(() => {
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    setReducedMotion(false);
    window.history.replaceState({}, '', '/hub/professores#planos');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('restores a cross-route hash after the asynchronous landing becomes ready', () => {
    const { rerender } = render(
      <HashNavigationHarness ready={false}>
        <section id="planos">Planos</section>
      </HashNavigationHarness>,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <HashNavigationHarness ready>
        <section id="planos">Planos</section>
      </HashNavigationHarness>,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(document.activeElement).toBe(document.body);
  });

  it('uses instant scrolling for reduced motion and focuses only an idle, focusable target', () => {
    setReducedMotion(true);
    document.body.innerHTML = '<button id="checkout">Checkout</button>';
    window.history.replaceState({}, '', '/hub/professores#checkout');

    expect(scrollToHubHashTarget()).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(document.activeElement).toBe(document.getElementById('checkout'));

    document.body.innerHTML = '<input id="active"><button id="next">Próximo</button>';
    const activeInput = document.getElementById('active') as HTMLInputElement;
    activeInput.focus();
    window.history.replaceState({}, '', '/hub/professores#next');

    expect(scrollToHubHashTarget()).toBe(true);
    expect(document.activeElement).toBe(activeInput);
  });

  it('reacts to a hash navigation after the landing is already visible', () => {
    render(
      <HashNavigationHarness ready>
        <><section id="planos">Planos</section><section id="jornada">Jornada</section></>
      </HashNavigationHarness>,
    );
    scrollIntoView.mockClear();

    act(() => {
      window.history.pushState({}, '', '/hub/professores#jornada');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('jornada'));
  });
});
