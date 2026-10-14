import datetime as dt, random
random.seed(20261014)
legacy=[("haircut","Haircut",30,3500),("student-haircut","Student haircut",30,3000),("kids-haircut","Kids haircut",30,2750),("line-up","Line-up",15,1750),("beard-trim-shape","Beard trim & shape",20,2250),("haircut-beard","Haircut + beard",45,4750),("haircut-colour","Haircut + colour",60,5500),("haircut+colour","Haircut + colour",60,5750)]
L=[]
def q(s): return "'"+str(s).replace("'","''")+"'"
today=dt.date(2026,10,14)
for c in range(1,21):
    L.append(f"INSERT INTO customer_accounts(id,email,name,phone,completed_visits) VALUES({q(f'cust-{c:03}')},{q(f'synthetic{c:03}@example.invalid')},{q(f'Synthetic Customer {c:03}')},{q(f'+3160000{c:04}')},{c%5});")
def slots(date,start,dur,aid):
    h,m=map(int,start.split(':')); t=h*60+m
    return [f"INSERT INTO appointment_slots(slot_start,appointment_id) VALUES({q(f'{date}T{(t+o)//60:02}:{(t+o)%60:02}')},{q(aid)});" for o in range(0,dur+10,5)]
n=0
for d in range(-20,21):
    day=today+dt.timedelta(days=d)
    if day.weekday()==6: continue
    for hour in random.sample(range(10,18,2),2):
        n+=1; sid,name,dur,price=random.choice(legacy)
        if d<0: status,pay=random.choice([("confirmed","due_at_shop"),("cancelled","due_at_shop"),("confirmed","paid"),("refunded","refunded")])
        else: status,pay=random.choice([("confirmed","due_at_shop"),("confirmed","paid"),("cancelled","due_at_shop")])
        if d==1 and n%2==0: status,pay=("payment_pending","pending")
        method="online" if pay in("paid","refunded","pending") else "pay_at_shop"
        aid=f"appt-{n:04}"; start=f"{hour:02}:00"; e=hour*60+dur; end=f"{e//60:02}:{e%60:02}"
        sess=f"cs_test_synthetic_{n:04}" if method=="online" else None
        L.append("INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,status,payment_method,payment_status,stripe_checkout_session_id,customer_account_id,source,revision) VALUES("+",".join([q(aid),q(f'AS-SYN{n:04}'),q(sid),q(name),str(dur),str(price),q(day.isoformat()),q(start),q(end),q(f'Synthetic Customer {n%20+1:03}'),q(f'synthetic{n%20+1:03}@example.invalid'),q(f'+3160000{n%20+1:04}'),q(status),q(method),q(pay),q(sess) if sess else 'NULL',q(f'cust-{n%20+1:03}'),q('online' if n%3 else 'walk_in'),str(n%3)])+");")
        if status in("confirmed","payment_pending"): L+=slots(day.isoformat(),start,dur,aid)
        if status=="refunded": L.append(f"INSERT INTO payment_refunds(id,appointment_id,stripe_refund_id,amount_cents,status,requested_by) VALUES({q('rf-'+aid)},{q(aid)},{q('re_test_syn'+str(n))},{price},'succeeded','synthetic-staff');")
        if pay=="paid" and d<0: L.append(f"INSERT INTO payment_receipts(id,appointment_id,amount_cents,method,actor_id) VALUES({q('rc-'+aid)},{q(aid)},{price},'card','synthetic-staff');")
        if n%7==0: L.append(f"INSERT INTO booking_changes(id,appointment_id,revision,action,actor_id,previous_date,previous_time,new_date,new_time) VALUES({q('bc-'+aid)},{q(aid)},1,'reschedule','synthetic-staff',{q(day.isoformat())},'09:00',{q(day.isoformat())},{q(start)});")
        if method=="online": L.append(f"INSERT INTO stripe_events(id,type) VALUES({q('evt_test_syn'+str(n))},'checkout.session.completed');")
vac=(today+dt.timedelta(days=30)).isoformat()
L.append(f"INSERT INTO time_off(id,date,start_time,end_time,reason,actor_id) VALUES('to-001',{q(vac)},'09:00','18:00','Synthetic vacation','synthetic-staff');")
L+=[f"INSERT INTO time_off_slots(slot_start,time_off_id) VALUES({q(f'{vac}T{x//60:02}:{x%60:02}')},'to-001');" for x in range(9*60,18*60,5)]
open('seed.sql','w').write("\n".join(L)+"\n"); print(n,len(L))
