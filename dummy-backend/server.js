// Dummy database backend for local testing -- implements the two
// endpoints from CUSTOMER_API_CONTRACT.md so you can verify the chatbot's
// "connect your own database" feature end to end. Not part of the
// chatbot product itself; this stands in for a real customer's backend.
const http = require("http");

const PORT = 5050;

const inventory = [
  {
    id: "yoga-flow",
    name: "Yoga Flow",
    description: "A slow, breath-led flow suitable for every level -- come as you are.",
    price: "15.00",
    tags: ["60 min", "All levels", "Mats provided"],
    availableCount: 8,
  },
  {
    id: "zumba-dance",
    name: "Zumba Dance",
    description: "High-energy dance cardio set to a live playlist.",
    price: "12.00",
    tags: ["45 min", "High energy"],
    availableCount: 0,
  },
  {
    id: "spin-cycle",
    name: "Spin Cycle",
    description: "Intense stationary cycling with interval sprints and hill climbs.",
    price: "18.00",
    tags: ["45 min", "Intense cardio"],
    availableCount: 5,
  },
  {
    id: "pilates-core",
    name: "Pilates Core",
    description: "Controlled, low-impact core and posture work.",
    price: "16.00",
    tags: ["50 min", "Low impact"],
    availableCount: 12,
  },
];

const bookings = {
  "PF-7Q2K9X": { reference: "PF-7Q2K9X", label: "Yoga Flow with Instructor Maya", startDate: "2026-09-10", endDate: null, status: "confirmed", quantity: 1 },
  "PF-3M8T5L": { reference: "PF-3M8T5L", label: "Spin Cycle, Morning Session", startDate: "2026-09-12", endDate: null, status: "pending", quantity: 2 },
};

http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/inventory") {
    res.end(JSON.stringify(inventory));
    return;
  }
  if (req.url.startsWith("/booking/")) {
    const ref = decodeURIComponent(req.url.split("/booking/")[1] || "");
    const booking = bookings[ref];
    if (!booking) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Booking not found" }));
      return;
    }
    res.end(JSON.stringify(booking));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}).listen(PORT, () => {
  console.log(`Pulse Fitness dummy backend listening on http://localhost:${PORT}`);
  console.log(`  GET /inventory`);
  console.log(`  GET /booking/PF-7Q2K9X  (confirmed)`);
  console.log(`  GET /booking/PF-3M8T5L  (pending)`);
});
