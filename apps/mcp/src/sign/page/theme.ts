// Light/dark toggle. The initial class is set by an inline script in <head> (no flash).
// Only a UI preference ("light" | "dark") is stored; nothing sensitive.
const KEY = "noacourt-theme";
const root = document.documentElement;
const media = matchMedia("(prefers-color-scheme: dark)");
function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
media.addEventListener("change", (event) => {
  if (!stored()) root.classList.toggle("dark", event.matches);
});
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const dark = !root.classList.contains("dark");
  root.classList.toggle("dark", dark);
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* preference not persisted */
  }
});
