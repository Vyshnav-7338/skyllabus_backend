function validationMessage(error) {
  const first = Object.values(error?.errors || {})[0];
  return first?.message || "The submitted data is invalid";
}

function sendApiError(res, error, options = {}) {
  console.error(error);
  const fallbackMessage = options.fallbackMessage || "Unable to complete request";

  if (error?.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      message: options.duplicateMessage || "A record with these details already exists",
    });
  }
  if (error?.name === "ValidationError") {
    return res.status(400).json({ success: false, message: validationMessage(error) });
  }
  if (error?.name === "CastError") {
    return res.status(400).json({ success: false, message: `Invalid ${error.path || "identifier"}` });
  }
  return res.status(500).json({ success: false, message: fallbackMessage });
}

module.exports = { sendApiError };
