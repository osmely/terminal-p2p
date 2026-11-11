-- La licencia va por usuario de QvaPay (qp:usuario). La primera cuenta confirmada por QvaPay que la usa la ata a su uuid:
-- si ese usuario llega a ser de otra cuenta, esa otra no hereda los días
ALTER TABLE pro_licenses ADD COLUMN qp_uuid TEXT;
