const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = {};

io.on("connection", (socket) => {

  socket.on("joinRoom", ({ roomId }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        users: [],
        gameStarted: false,
        speakers: [],
        messages: []
      };
    }

    const room = rooms[roomId];

    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已开始");
      return;
    }

    const user = {
      id: socket.id,
      name: "匿名" + Math.floor(Math.random() * 10000)
    };

    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;

    io.to(roomId).emit("updateUsers", room.users);
  });

  socket.on("startGame", () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.gameStarted = true;

    const shuffled = [...room.users].sort(() => 0.5 - Math.random());
    room.speakers = shuffled.slice(0, 2);

    io.to(socket.roomId).emit("gameStarted");
  });

  socket.on("sendMessage", (msg) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const isSpeaker = room.speakers.find(u => u.id === socket.id);
    if (!isSpeaker) return;

    const message = {
      text: msg
    };

    room.messages.push(message);
    io.to(socket.roomId).emit("newMessage", message);
  });

  socket.on("endGame", () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    io.to(socket.roomId).emit("gameEnded", {
      speakers: room.speakers,
      messages: room.messages
    });

    room.gameStarted = false;
    room.speakers = [];
    room.messages = [];
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
