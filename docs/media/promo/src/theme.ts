export const MINT = '#3ee0c5';
export const BLUE = '#6ea8ff';
export const AMBER = '#f0c14a';
export const ROSE = '#ff7b8a';
export const TEXT = '#eef3ff';
export const MUTED = '#8b97ad';
export const PANEL = '#101826';
export const FONT =
  "'Segoe UI','Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif";

export const fadeInOut = (
  frame: number,
  total: number,
  fade = 14,
): number => {
  const t = Math.max(0, Math.min(total, frame));
  if (t < fade) return t / fade;
  if (t > total - fade) return (total - t) / fade;
  return 1;
};
