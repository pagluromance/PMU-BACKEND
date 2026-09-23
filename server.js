require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const createRouter = require('./src/routes');

const app = express();
const server = http.createServer(app);

// Socket.IO lets the dashboard receive new readings the instant they arrive,
// instead of the browser having to repeatedly ask "is there new data yet?"
const io = new Server(server, {
  cors: { origin: '*' }, // fine for a student project; tighten this if it ever goes public
});

app.use(cors());
app.use(express.json()); // lets us read JSON bodies sent by the PMU devices

app.get('/', (req, res) => {
  res.send('PMU backend is running.');
});

app.use('/api', createRouter(io));

io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  socket.on('disconnect', () => console.log('Dashboard disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PMU backend listening on port ${PORT}`);
});
