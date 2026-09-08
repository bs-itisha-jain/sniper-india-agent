import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import Scope from "../components/Scope.jsx";

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <Scope />
          <span>Sniper</span>
        </div>

        <h1>Lock in.</h1>
        <p className="sub">
          One shared desk for placing single-leg Zerodha GTT orders.
        </p>

        <div className="field">
          <label htmlFor="u">Username</label>
          <input
            id="u"
            className="control"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>

        <div className="field">
          <label htmlFor="p">Password</label>
          <input
            id="p"
            type="password"
            className="control"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        {error && (
          <div className="notice err" role="alert">
            {error}
          </div>
        )}

        <button
          className="btn block"
          type="submit"
          disabled={busy}
          style={{ marginTop: 16 }}
        >
          {busy ? <span className="spin" /> : "Enter the desk"}
        </button>
      </form>
    </div>
  );
}
