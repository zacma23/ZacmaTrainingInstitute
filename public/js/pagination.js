(function () {
  const DEFAULT_PAGE_SIZES = [10, 25, 50, 100];
  const stateMap = new Map();

  function getOrInitState(tableId, defaultPageSize) {
    if (!stateMap.has(tableId)) {
      stateMap.set(tableId, {
        page: 1,
        pageSize: defaultPageSize || 10,
        lastFilterKey: undefined,
        lastOpts: null,
      });
    }
    return stateMap.get(tableId);
  }

  function buildPageNumbers(currentPage, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
    const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
        out.push('...');
      }
      out.push(sorted[i]);
    }
    return out;
  }

  function findOrCreateBar(tbody) {
    const tableScroll = tbody.closest('.table-scroll');
    const hostParent = tableScroll ? tableScroll.parentElement : tbody.closest('table')?.parentElement;
    if (!hostParent) return null;

    const barId = `pagination-${tbody.id}`;
    let bar = document.getElementById(barId);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = barId;
      bar.className = 'pagination-bar';
      if (tableScroll && tableScroll.nextSibling) {
        hostParent.insertBefore(bar, tableScroll.nextSibling);
      } else if (tableScroll) {
        hostParent.appendChild(bar);
      } else {
        hostParent.appendChild(bar);
      }
    }
    return bar;
  }

  function render(opts) {
    const {
      tableId,
      items = [],
      renderRow,
      emptyHtml = '',
      defaultPageSize = 10,
      resetPage = false,
      filterKey,
      pageSizes = DEFAULT_PAGE_SIZES,
    } = opts || {};

    const tbody = document.getElementById(tableId);
    if (!tbody) return;

    const st = getOrInitState(tableId, defaultPageSize);
    if (resetPage || (filterKey !== undefined && filterKey !== st.lastFilterKey)) {
      st.page = 1;
    }
    if (filterKey !== undefined) {
      st.lastFilterKey = filterKey;
    }
    st.lastOpts = opts;

    const totalItems = Array.isArray(items) ? items.length : 0;
    const bar = findOrCreateBar(tbody);

    if (totalItems === 0) {
      tbody.innerHTML = emptyHtml;
      if (bar) {
        bar.style.display = 'none';
        bar.innerHTML = '';
      }
      return;
    }

    const pageSize = Math.max(1, Number(st.pageSize) || 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    if (st.page > totalPages) st.page = totalPages;
    if (st.page < 1) st.page = 1;

    const startIdx = (st.page - 1) * pageSize;
    const endIdx = Math.min(totalItems, startIdx + pageSize);
    const pageSlice = items.slice(startIdx, endIdx);

    tbody.innerHTML = pageSlice.map((item, idx) => renderRow(item, startIdx + idx)).join('');

    if (!bar) return;
    bar.style.display = 'flex';

    const pageTokens = buildPageNumbers(st.page, totalPages);
    bar.innerHTML = `
      <div class="pagination-info">
        Showing <strong class="mono">${startIdx + 1}–${endIdx}</strong> of <strong class="mono">${totalItems}</strong> entries
      </div>
      <div class="pagination-controls">
        <label class="pagination-size-label">
          <span>Rows:</span>
          <select class="pagination-size-select" aria-label="Rows per page">
            ${pageSizes
              .map((sz) => `<option value="${sz}" ${sz === pageSize ? 'selected' : ''}>${sz}</option>`)
              .join('')}
          </select>
        </label>
        <div class="pagination-pages">
          <button type="button" class="btn btn-secondary btn-xs pg-prev" ${st.page <= 1 ? 'disabled' : ''}>Prev</button>
          ${pageTokens
            .map((tok) =>
              tok === '...'
                ? '<span class="pagination-ellipsis">&hellip;</span>'
                : `<button type="button" class="btn ${tok === st.page ? 'btn-primary' : 'btn-secondary'} btn-xs pg-num" data-page="${tok}">${tok}</button>`
            )
            .join('')}
          <button type="button" class="btn btn-secondary btn-xs pg-next" ${st.page >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    const sizeSel = bar.querySelector('.pagination-size-select');
    if (sizeSel) {
      sizeSel.addEventListener('change', (e) => {
        st.pageSize = Number(e.target.value) || defaultPageSize;
        st.page = 1;
        render({ ...st.lastOpts, resetPage: false });
      });
    }

    const prevBtn = bar.querySelector('.pg-prev');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (st.page > 1) {
          st.page -= 1;
          render({ ...st.lastOpts, resetPage: false });
        }
      });
    }

    const nextBtn = bar.querySelector('.pg-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (st.page < totalPages) {
          st.page += 1;
          render({ ...st.lastOpts, resetPage: false });
        }
      });
    }

    bar.querySelectorAll('.pg-num').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = Number(btn.dataset.page);
        if (target && target !== st.page) {
          st.page = target;
          render({ ...st.lastOpts, resetPage: false });
        }
      });
    });

    if (window.lucide) {
      try {
        window.lucide.createIcons();
      } catch {
        // ignore
      }
    }
  }

  function reset(tableId) {
    const st = stateMap.get(tableId);
    if (st) st.page = 1;
  }

  window.BirrPagination = {
    render,
    reset,
  };
})();
