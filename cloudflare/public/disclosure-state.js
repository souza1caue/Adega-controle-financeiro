// Sections already controlled by page filters keep their explicit open flags.
const controlled = '.cash-reports,.cash-financial-details,.overview-period-details,.overview-sales-history,.cash-current-sales,.settled-accounts-history,.stock-history,[data-stock-purchase-history],.kitchen-history,.front-kitchen-history';

export function createDisclosureState() {
  const views = new Map();
  let renderedView;
  function identity(element) {
    if (element.dataset.disclosureKey) return element.dataset.disclosureKey;
    const classes = [...element.classList].sort().join('.');
    if (classes) return classes;
    const summary = element.querySelector(':scope > summary');
    return summary?.textContent.trim() || 'details';
  }
  function key(element, root) {
    const path = [identity(element)];
    let parent = element.parentElement?.closest('details');
    while (parent && root.contains(parent)) {
      path.unshift(identity(parent));
      parent = parent.parentElement?.closest('details');
    }
    return JSON.stringify(path);
  }
  return {
    capture(root) {
      if (renderedView === undefined) return;
      const state = views.get(renderedView) || new Map();
      for (const element of root.querySelectorAll('details')) {
        if (!element.matches(controlled)) state.set(key(element, root), element.open);
      }
      views.set(renderedView, state);
    },
    restore(root, view) {
      renderedView = view;
      const state = views.get(view);
      if (!state) return;
      for (const element of root.querySelectorAll('details')) {
        if (element.matches(controlled)) continue;
        const id = key(element, root);
        if (state.has(id)) element.open = state.get(id);
      }
    },
  };
}
