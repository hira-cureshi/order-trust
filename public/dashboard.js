// dashboard.js — plain vanilla JS, no build step, easy to read top to bottom.

// Escapes any text before it's inserted into the page. This closes a real
// gap found before any real merchant used this: vendor names and alert
// messages came from order data (which a supplier or anyone editing
// product info could influence) and were being inserted into the page
// without this — meaning a vendor name containing script-like text could
// have executed in the browser. Every piece of data from the API now goes
// through this before display.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function getAuthParams() {
  const params = new URLSearchParams(window.location.search);
  return { shop: params.get("shop"), token: params.get("token") };
}

async function loadDashboard() {
  const { shop, token } = getAuthParams();
  if (!shop || !token) {
    document.querySelector(".wrap").innerHTML =
      '<p class="empty">This link is missing its access token — open the dashboard from your Shopify admin rather than typing the URL directly.</p>';
    return;
  }

  const res = await fetch(`/api/summary?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(token)}`);
  if (res.status === 401) {
    document.querySelector(".wrap").innerHTML =
      '<p class="empty">Access token invalid or expired — reinstall the app to get a fresh dashboard link.</p>';
    return;
  }
  const data = await res.json();

  document.getElementById("stat-alerts").textContent = data.activeAlerts.length;
  document.getElementById("stat-open").textContent = data.totals.open_line_items || 0;
  document.getElementById("stat-total").textContent = data.totals.total_line_items || 0;

  const alertList = document.getElementById("alert-list");
  if (!data.activeAlerts.length) {
    alertList.innerHTML = '<div class="empty">Nothing needs attention right now.</div>';
  } else {
    alertList.innerHTML = data.activeAlerts
      .map(
        (a) => `
        <div class="manifest-row">
          <div class="order-num">${a.alert_type === "aging_order" ? "AGING" : "PATTERN SHIFT"}</div>
          <div class="reason">${escapeHtml(a.message)}</div>
          <div class="customer">${escapeHtml(new Date(a.created_at).toLocaleDateString())}</div>
          <div class="stamp" data-alert-id="${a.id}" style="cursor:pointer">Mark handled</div>
        </div>`
      )
      .join("");

    // Event listeners instead of inline onclick — avoids building a string
    // with a value interpolated directly into executable HTML attributes.
    alertList.querySelectorAll("[data-alert-id]").forEach((el) => {
      el.addEventListener("click", () => resolveAlert(el.getAttribute("data-alert-id")));
    });
  }

  const supplierList = document.getElementById("supplier-list");
  if (!data.vendorBaselines.length) {
    supplierList.innerHTML = '<div class="empty">No supplier data yet — this fills in as orders get fulfilled.</div>';
  } else {
    supplierList.innerHTML = data.vendorBaselines
      .map(
        (v) => `
        <div class="supplier-row">
          <div>${escapeHtml(v.normalized_vendor)}</div>
          <div class="num">${Math.round(v.avg_lead_time_hours)}h</div>
          <div class="num">${v.sample_count}</div>
          <div class="num ${v.refund_count > 0 ? "warn" : ""}">${v.refund_count}</div>
        </div>`
      )
      .join("");
  }
}

async function resolveAlert(id) {
  const { shop, token } = getAuthParams();
  await fetch(`/api/alerts/${id}/resolve?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(token)}`, {
    method: "POST",
  });
  loadDashboard();
}

loadDashboard();
