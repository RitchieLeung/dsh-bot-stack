/**
 * Client half of the Bot knowledge panel.
 *
 * A plain script served to the DSH Web GUI: the shell calls the registered
 * factory with a `require` bound to the host's module table. No build step.
 */
window.__ModuleLoader__.load({
  id: 'bot-knowledge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Icon({ size }) {
      const s = size || 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z' }),
        h('path', { d: 'M19 18.5V21H6.5' }));
    }

    function Page() {
      return h('div', { style: { padding: 24, color: 'var(--dsw-alias-label-primary)' } }, '知识库');
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bot-knowledge', label: () => '知识库', order: 30,
      }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'bot-knowledge',
      }, Page));
    }

    return { inject: ['slots'], apply };
  },
});
