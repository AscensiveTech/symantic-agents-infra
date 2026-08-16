function notImplemented(operation) {
  const error = new Error(`not_implemented: ${operation}`);
  error.code = "not_implemented";
  throw error;
}

export async function getAvailability() {
  notImplemented("getAvailability");
}

export async function createBooking() {
  notImplemented("createBooking");
}

export async function rescheduleBooking() {
  notImplemented("rescheduleBooking");
}

export async function cancelBooking() {
  notImplemented("cancelBooking");
}
