// Frozen summary of the values checked at cash closing. Detailed audit records
// remain in the database and reports can still load them by cash/period.
export async function closingSummary(db, cashId, sales) {
  const read = async kind => (await db.prepare("SELECT id,data FROM records WHERE kind=? AND json_extract(data,'$.cash_session_id')=?").bind(kind,cashId).all()).results.map(row=>({id:row.id,...JSON.parse(row.data)}));
  const [shifts, events, movements] = await Promise.all(['staff_shifts','hosted_events','stock_events'].map(read));
  const menuCosts = new Map();
  async function unitCost(sale) {
    if (sale.unit_cost != null) return Number(sale.unit_cost);
    if (sale.stock_usage?.length) return sale.stock_usage.reduce((sum,item)=>sum+Number(item.quantity||0)*Number(item.unit_cost||0),0)/Number(sale.quantity||1);
    if (!menuCosts.has(sale.menu_id)) {
      const row=await db.prepare("SELECT data FROM records WHERE kind='menu' AND id=?").bind(sale.menu_id||'').first();
      menuCosts.set(sale.menu_id,Number(row?JSON.parse(row.data).cost_price||0:0));
    }
    return menuCosts.get(sale.menu_id);
  }
  let products=0, known=true;
  const eventCosts=new Map();
  for(const sale of sales){
    const cost=await unitCost(sale),total=cost*Number(sale.quantity||0);
    known &&= cost>0 && (sale.cost_mode==='fixed'||!sale.stock_usage?.length||sale.stock_usage.every(item=>Number(item.unit_cost)>0));
    if(sale.hosted_event_id)eventCosts.set(sale.hosted_event_id,(eventCosts.get(sale.hosted_event_id)||0)+total);
    else products+=total;
  }
  const active=movements.filter(item=>!item.cancelled_at),validShifts=shifts.filter(item=>item.status!=='cancelled');
  let operating=validShifts.reduce((sum,item)=>sum+Number(item.daily_rate||0),0);
  operating+=active.filter(item=>item.event_type==='staff_consumption'&&!item.hosted_event_id).reduce((sum,item)=>sum+Number(item.total_cost||0),0);
  for(const event of events){
    if(event.event_mode==='contracted'&&!validShifts.some(item=>item.id===event.fee_shift_id))operating+=Number(event.fee_amount||0);
    operating+=event.simple_event
      ? event.consumption_mode==='fixed'?Number(event.fixed_consumption||0):active.filter(item=>item.hosted_event_id===event.id).reduce((sum,item)=>sum+Number(item.total_cost||0),0)
      : eventCosts.has(event.id)?eventCosts.get(event.id):Number(event.actual_cost||0);
  }
  const waste=active.filter(item=>['loss','courtesy'].includes(item.event_type)).reduce((sum,item)=>sum+Number(item.total_cost||0),0);
  const salesTotal=sales.reduce((sum,item)=>sum+Number(item.quantity||0)*Number(item.price||0),0),cost=products+operating+waste;
  const round=value=>Math.round(value*100)/100;
  return {version:1,sales:round(salesTotal),cost:round(cost),profit:round(salesTotal-cost),known,product_cost:round(products),operating_cost:round(operating),loss_courtesy_cost:round(waste)};
}
