const API_BASE =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname}:3001`
    : "http://localhost:3001");

export default API_BASE;
