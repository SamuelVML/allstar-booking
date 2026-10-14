INSERT INTO booking_obligations(id,appointment_id,change_id,kind,status,attempts,last_error) VALUES('ob-1','appt-0007','bc-appt-0007','notify','pending',0,NULL);
INSERT INTO booking_obligations(id,appointment_id,change_id,kind,status,attempts,last_error) VALUES('ob-2','appt-0014','bc-appt-0014','notify','pending',2,'timeout');
INSERT INTO booking_obligations(id,appointment_id,change_id,kind,status,attempts,last_error) VALUES('ob-3','appt-0021','bc-appt-0021','notify','done',1,NULL);
INSERT INTO booking_obligations(id,appointment_id,change_id,kind,status,attempts,last_error) VALUES('ob-4','appt-0028','bc-appt-0028','refund','pending',1,'stripe 500');
