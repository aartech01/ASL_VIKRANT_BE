// Gates write endpoints behind a shared admin key so the site can stay publicly
// viewable while only the person holding ADMIN_KEY can make changes.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) {
    // Fail closed: an unset key must never mean "anyone can edit".
    return res.status(500).json({ error: "Server is not configured with an admin key" });
  }
  const provided = req.get("x-admin-key");
  if (provided !== expected) {
    return res.status(401).json({ error: "Admin key required" });
  }
  next();
}

module.exports = requireAdmin;
