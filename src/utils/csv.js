function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  let str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.includes('"')) str = str.replace(/"/g, '""');
  if (/[",\n\r]/.test(str)) str = `"${str}"`;
  return str;
}

export function postsToCsv(posts) {
  const first = posts && posts.length ? posts[0] : null;
  const keys =
    first && typeof first === 'object' ? Object.keys(first) : [];
  const header = keys.map(escapeCsvValue).join(',');
  const lines = posts.map((p) =>
    keys.map((k) => escapeCsvValue(p?.[k])).join(','),
  );
  return [header, ...lines].join('\n');
}

export function dailyStatsToCsv(dailyStats) {
  const rows = Object.entries(dailyStats || {}).map(([day, stats]) => ({
    day,
    photo: stats?.photo ?? 0,
    reels: stats?.reels ?? 0,
    carousel: stats?.carousel ?? 0,
  }));
  const header = 'day,photo,reels,carousel';
  const lines = rows.map(
    (r) =>
      [
        escapeCsvValue(r.day),
        escapeCsvValue(r.photo),
        escapeCsvValue(r.reels),
        escapeCsvValue(r.carousel),
      ].join(','),
  );
  return [header, ...lines].join('\n');
}
