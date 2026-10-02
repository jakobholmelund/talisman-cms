/** Schema-safe SQLite canonical email expression, shared by indexed columns and comparisons. */
export function canonicalEmailSql(address: string) {
  const email = `lower(trim(${address}))`;
  const at = `instr(${email}, '@')`;
  const local = `substr(${email}, 1, ${at} - 1)`;
  const domain = `rtrim(substr(${email}, ${at} + 1), '.')`;
  const base = `(CASE WHEN instr(${local}, '+') > 1 THEN substr(${local}, 1, instr(${local}, '+') - 1) ELSE ${local} END)`;
  return `(CASE WHEN ${at} < 2 OR ${domain} = '' THEN NULL
    WHEN ${domain} IN ('gmail.com', 'googlemail.com') THEN replace(${base}, '.', '') || '@gmail.com'
    ELSE ${base} || '@' || ${domain} END)`;
}
