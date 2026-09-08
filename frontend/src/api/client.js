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
      credentials: "include",
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
  login: (username, password) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),

  ltp: (symbol) => request(`/ltp?symbol=${encodeURIComponent(symbol)}`),
  createGtt: (payload) =>
    request("/order", { method: "POST", body: JSON.stringify(payload) }),
  listGtt: () => request("/orders/gtt"),
  updateGtt: (id, payload) =>
    request(`/orders/gtt/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  cancelGtt: (id) => request(`/orders/gtt/${id}`, { method: "DELETE" }),

  tokenStatus: () => request("/token/status"),
  refreshToken: () => request("/token/refresh", { method: "POST" }),
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
