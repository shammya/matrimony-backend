export const eventQueries = {
  append: `INSERT INTO matrimony.event_outbox (agency_id,id,event) VALUES ($1,$2,$3)`,
  claim: `WITH due AS (
   SELECT id FROM matrimony.event_outbox WHERE agency_id=$1 AND delivered_at IS NULL
   AND attempts < $2 AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
   ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE matrimony.event_outbox e SET lease_token=$3,lease_until=now()+interval '30 seconds',attempts=attempts+1
 FROM due WHERE e.agency_id=$1 AND e.id=due.id RETURNING e.event,e.attempts,e.lease_token`,
  acknowledge: `UPDATE matrimony.event_outbox SET delivered_at=now(),lease_until=NULL,lease_token=NULL
 WHERE agency_id=$1 AND id=$2 AND lease_token=$3`,
  retry: `UPDATE matrimony.event_outbox SET next_attempt_at=now()+($4 * interval '1 millisecond'),
 lease_until=NULL,lease_token=NULL,last_error_code='MONGO_DELIVERY_FAILED' WHERE agency_id=$1 AND id=$2 AND lease_token=$3`,
};
