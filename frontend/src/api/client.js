const BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ApiError";
    this.code = code || "api_error";
    this.status = status;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    // fetch only rejects when the request never reached the server
    throw new ApiError("Can't reach the server — is the backend running?", "offline", 0);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      data.error || `Request failed (${res.status})`,
      data.code,
      res.status
    );
  }
  return data;
}

export const api = {
  ltp: (symbol) => request(`/ltp?symbol=${encodeURIComponent(symbol)}`),
  createGtt: (payload) =>
    request("/order", { method: "POST", body: JSON.stringify(payload) }),
  listGtt: () => request("/orders/gtt"),
  orders: (opts = {}) =>
    request(`/orders${opts.completeOnly ? "?status=complete" : ""}`),
  updateGtt: (id, payload) =>
    request(`/orders/gtt/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  cancelGtt: (id) => request(`/orders/gtt/${id}`, { method: "DELETE" }),

  tokenStatus: () => request("/token/status"),
  loginUrl: () => request("/token/login-url"),
  submitRequestToken: (requestToken) =>
    request("/token/manual", {
      method: "POST",
      body: JSON.stringify({ request_token: requestToken }),
    }),
  setAccessToken: (accessToken) =>
    request("/token/set", {
      method: "POST",
      body: JSON.stringify({ access_token: accessToken }),
    }),
};
