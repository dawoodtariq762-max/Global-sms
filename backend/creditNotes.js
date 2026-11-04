'use strict';
/** Read-only LIVE settlement statements, not issued financial documents.
 * This module never writes, backfills, reprices, changes eligibility or pays a ledger.
 * Ledger amounts are summed as decimal strings using BigInt (no float rounding).
 */
function addDecimal(a, b) {
  const parse = value => {
    const s = String(value == null || value === '' ? '0' : value).trim();
    if (s.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(s)) throw new Error('Invalid ledger amount');
    const [whole, frac = ''] = s.replace(/^-/, '').split('.');
    return { n: BigInt(whole + frac) * (s.startsWith('-') ? -1n : 1n), scale: frac.length };
  };
  const x = parse(a), y = parse(b), scale = Math.max(x.scale, y.scale);
  const sum = x.n * 10n ** BigInt(scale - x.scale) + y.n * 10n ** BigInt(scale - y.scale);
  const negative = sum < 0n; let out = (negative ? -sum : sum).toString().padStart(scale + 1, '0');
  if (scale) out = (out.slice(0, -scale) + '.' + out.slice(-scale)).replace(/\.?0+$/, '');
  return (negative && out !== '0' ? '-' : '') + out;
}
function dateOnly(value) {
  if (!value) return '';
  const s = String(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Dates must use YYYY-MM-DD');
  const d = new Date(s + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('Invalid date');
  return s;
}
function statements(db, user, q = {}, now = new Date()) {
  const where = [], params = [];
  if (user.role === 'agent') { where.push('l.agent_id=?'); params.push(user.id); }
  else if (user.role === 'manager') {
    // Same direct-child boundary as /payment-v2/manager/agents. No new hierarchy scope.
    where.push("l.agent_id IN (SELECT id FROM users WHERE role='agent' AND parent_id=?)"); params.push(user.id);
  } else if (user.role !== 'admin') { const e = new Error('Forbidden'); e.status = 403; throw e; }
  if (q.agent_id) {
    if (!/^\d+$/.test(String(q.agent_id)) || Number(q.agent_id) < 1) throw new Error('Invalid agent_id');
    if (user.role === 'agent' && Number(q.agent_id) !== user.id) { const e = new Error('Forbidden'); e.status = 403; throw e; }
    where.push('l.agent_id=?'); params.push(Number(q.agent_id));
  }
  const from = dateOnly(q.from), to = dateOnly(q.to);
  if (from && to && from > to) throw new Error('From date must not exceed To date');
  if (from) { where.push('l.cycle_key>=?'); params.push(from); }
  if (to) { where.push('l.cycle_key<=?'); params.push(to); }
  if (q.payment_type) {
    if (!['daily', 'weekly', 'monthly_30x45'].includes(String(q.payment_type))) throw new Error('Invalid payment_type');
    where.push('l.payment_type=?'); params.push(q.payment_type);
  }
  const nowSql = now.toISOString().slice(0,19).replace('T',' ');
  const maturity = String(q.maturity || '');
  if (maturity && !['matured','upcoming','unknown'].includes(maturity)) throw new Error('Invalid maturity');
  if (maturity === 'matured') {where.push("l.eligible_at<>'' AND l.eligible_at<=?");params.push(nowSql);}
  if (maturity === 'upcoming') {where.push('l.eligible_at>?');params.push(nowSql);}
  if (maturity === 'unknown') where.push("COALESCE(l.eligible_at,'')=''");
  const limit = Math.max(1, Math.min(100, parseInt(q.limit,10) || 25));
  const filter = where.length ? where.join(' AND ') : '1=1';
  const keys = "l.agent_id, l.payment_type, COALESCE(l.cycle_key,'') AS cycle_key, COALESCE(l.eligible_at,'') AS eligible_at";
  const group = "l.agent_id,l.payment_type,COALESCE(l.cycle_key,''),COALESCE(l.eligible_at,'')";
  const groupsSql = `SELECT ${keys} FROM payment_ledger l WHERE ${filter} GROUP BY ${group}`;
  const total = Number(db.get(`SELECT COUNT(*) AS n FROM (${groupsSql})`, params)?.n || 0);
  const totalPages = Math.max(1,Math.ceil(total / limit));
  const page = Math.min(totalPages,Math.max(1,parseInt(q.page,10)||1));
  const pagedSql = `${groupsSql} ORDER BY cycle_key DESC, eligible_at DESC, agent_id, payment_type LIMIT ? OFFSET ?`;
  const selected = db.all(pagedSql,[...params,limit,(page-1)*limit]);
  const keyOf = r => JSON.stringify([r.agent_id,r.payment_type,r.cycle_key||'',r.eligible_at||'']);
  const rows = selected.map(r=>({...r, agent_name:'', currency:null, total_amount:'0', open_amount:'0', requested_amount:'0', paid_amount:'0', other_amount:'0', ledger_entries:0, cdr_count:0, first_earned_at:null,last_earned_at:null,request_ids:[], maturity:!r.eligible_at?'unknown':r.eligible_at<=nowSql?'matured':'upcoming'}));
  const index = new Map(rows.map(r=>[keyOf(r),r]));
  if (rows.length) {
    const sql = `WITH selected AS (${pagedSql})
      SELECT l.*, u.username AS agent_name FROM payment_ledger l
      JOIN selected k ON k.agent_id=l.agent_id AND k.payment_type=l.payment_type
        AND k.cycle_key=COALESCE(l.cycle_key,'') AND k.eligible_at=COALESCE(l.eligible_at,'')
      LEFT JOIN users u ON u.id=l.agent_id ORDER BY l.id`;
    for (const item of db.iterate(sql,[...params,limit,(page-1)*limit])) {
      const row=index.get(keyOf(item)); if(!row)continue;
      row.agent_name=item.agent_name||`Agent #${item.agent_id}`;
      row.total_amount=addDecimal(row.total_amount,item.amount);
      const field={open:'open_amount',requested:'requested_amount',paid:'paid_amount'}[item.status]||'other_amount';
      row[field]=addDecimal(row[field],item.amount); row.ledger_entries++;
      if(item.sms_record_id!=null)row.cdr_count++; // ledger's sms_record_id is UNIQUE
      if(item.earned_at && (!row.first_earned_at||item.earned_at<row.first_earned_at))row.first_earned_at=item.earned_at;
      if(item.earned_at && (!row.last_earned_at||item.earned_at>row.last_earned_at))row.last_earned_at=item.earned_at;
      if(item.request_id!=null&&!row.request_ids.includes(item.request_id))row.request_ids.push(item.request_id);
    }
  }
  for(const row of rows)row.matured_open_amount=row.maturity==='matured'?row.open_amount:'0';
  return {read_only:true,issued:false,generated_at:now.toISOString(),date_filter:'stored cycle_key',total,page,limit,totalPages,rows,
    notes:['Live settlement statement, not an issued Credit Note or a new balance credit.',
      'Amounts are existing ledger units. Historical currency is not recorded on the ledger; no currency is inferred or converted.',
      'Weekly is shown as stored; historical 7/1 versus 7/7 is not inferred.',
      'Matured means the stored eligibility date has passed, not that payment was made. Existing PIN, minimum and request rules still apply.']};
}
function mount(app, {db,authRequired,requireRole,requireAgentChatUnlock}) {
  app.get('/api/payment-v2/credit-notes', authRequired, requireRole('admin','manager','agent'), requireAgentChatUnlock, (req,res)=>{
    res.set('Cache-Control','no-store');
    try {res.json(statements(db,req.user,req.query));}
    catch(e){res.status(e.status||400).json({error:e.message||'Unable to read settlement statement'});}
  });
}
module.exports={mount,statements,addDecimal};
