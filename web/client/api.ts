export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data as T;
}
export const post = <T,>(url: string, body: unknown = {}) => api<T>(url, { method: "POST", body: JSON.stringify(body) });
export const contentUrl = (ws: string, doc: string, download = false, version?: string) => `/api/workspaces/${ws}/documents/${doc}/content?${new URLSearchParams({ ...(download ? {download:"1"}:{}), ...(version ? {version}: {}) })}`;
export function unitName(label: string) {
  if (label.startsWith("p.")) return `第 ${label.slice(2)} 页`;
  if (label.startsWith("¶")) return `段落 ${label.slice(1)}`;
  if (label.startsWith("sl.")) return `幻灯片 ${label.slice(3)}`;
  if (label.startsWith("sh.")) return `工作表 ${label.slice(3)}`;
  return label;
}
