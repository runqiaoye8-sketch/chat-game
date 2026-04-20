const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));

const rooms = {};

function generateRoomId() {
  return uuidv4().substring(0, 6).toUpperCase();
}

io.on("connection", (socket) => {
  console.log("用户连接:", socket.id);

  socket.on("createRoom", () => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      id: roomId,
      users: [],
      gameStarted: false,
      speakers: [],
      anonymousMap: {},
      messages: [],
      preGameMessages: [],
      votes: {},
      creator: socket.id
    };
    socket.emit("roomCreated", roomId);
    console.log(`房间 ${roomId} 已创建`);
  });

  socket.on("joinRoom", ({ roomId, userName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMsg", "房间不存在");
      return;
    }
    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已开始，无法加入");
      return;
    }
    if (!userName || userName.trim() === "") {
      socket.emit("errorMsg", "请输入姓名");
      return;
    }
    const trimmedName = userName.trim();
    const existing = room.users.find(u => u.socketId === socket.id);
    if (existing) {
      socket.emit("errorMsg", "你已经在房间中");
      return;
    }

    const user = {
      id: uuidv4(),
      socketId: socket.id,
      name: trimmedName
    };
    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = trimmedName;
    socket.userId = user.id;

    socket.emit("joinSuccess", {
      roomId,
      userName: trimmedName,
      isCreator: room.creator === socket.id,
      users: room.users.map(u => ({ id: u.id, name: u.name }))
    });

    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
    socket.emit("preGameHistory", room.preGameMessages);
    console.log(`${trimmedName} 加入房间 ${roomId}`);
  });

  socket.on("publicMessage", (msg) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.gameStarted) return;
    const user = room.users.find(u => u.socketId === socket.id);
    if (!user) return;

    const message = {
      senderName: user.name,
      senderId: user.id,
      text: msg,
      timestamp: Date.now()
    };
    room.preGameMessages.push(message);
    io.to(roomId).emit("publicMessage", message);
  });

  socket.on("startGame", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.gameStarted) return;
    if (room.users.length < 2) {
      socket.emit("errorMsg", "至少需要2人才能开始");
      return;
    }

    room.gameStarted = true;
    const shuffled = [...room.users].sort(() => 0.5 - Math.random());
    const selectedSpeakers = shuffled.slice(0, 2);
    room.speakers = selectedSpeakers.map(s => s.socketId);
    room.anonymousMap = {};
    room.anonymousMap[selectedSpeakers[0].socketId] = "匿名A";
    room.anonymousMap[selectedSpeakers[1].socketId] = "匿名B";
    room.votes = {};
    room.messages = [];

    room.users.forEach(user => {
      const isSpeaker = room.speakers.includes(user.socketId);
      const anonName = isSpeaker ? room.anonymousMap[user.socketId] : null;
      io.to(user.socketId).emit("gameStarted", {
        isSpeaker,
        anonymousName: anonName,
        speakers: room.speakers.map(sockId => {
          const u = room.users.find(u => u.socketId === sockId);
          return { socketId: sockId, anonymousName: room.anonymousMap[sockId] };
        }),
        allUsers: room.users.map(u => ({ id: u.id, name: u.name }))
      });
    });

    io.to(roomId).emit("gameStateChanged", { gameStarted: true });
  });

  socket.on("anonymousMessage", (msg) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.gameStarted) return;
    if (!room.speakers.includes(socket.id)) {
      socket.emit("errorMsg", "你已被禁言");
      return;
    }
    const anonName = room.anonymousMap[socket.id];
    if (!anonName) return;

    const message = {
      anonymousName: anonName,
      text: msg,
      timestamp: Date.now()
    };
    room.messages.push(message);
    io.to(roomId).emit("anonymousMessage", message);
  });

  socket.on("submitVote", ({ guessForA, guessForB }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.gameStarted) return;
    if (room.speakers.includes(socket.id)) {
      socket.emit("errorMsg", "发言者不能投票");
      return;
    }

    const userNames = room.users.map(u => u.name);
    if (!userNames.includes(guessForA) || !userNames.includes(guessForB)) {
      socket.emit("errorMsg", "无效的投票选项");
      return;
    }

    room.votes[socket.id] = {
      speakerA: guessForA,
      speakerB: guessForB
    };

    socket.emit("voteConfirmed");
  });

  socket.on("endGame", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.gameStarted) return;

    // 构建发言者真实身份
    const speakerA = room.users.find(u => u.socketId === room.speakers[0]);
    const speakerB = room.users.find(u => u.socketId === room.speakers[1]);
    const speakerDetails = [
      {
        anonymousName: "匿名A",
        realName: speakerA ? speakerA.name : "已离开"
      },
      {
        anonymousName: "匿名B",
        realName: speakerB ? speakerB.name : "已离开"
      }
    ];

    // 统计投票结果
    const voteEntries = Object.entries(room.votes);
    const voteResults = [];
    let correctA = 0, correctB = 0;

    voteEntries.forEach(([voterId, vote]) => {
      const voter = room.users.find(u => u.socketId === voterId);
      const voterName = voter ? voter.name : "未知";
      const isCorrectA = (vote.speakerA === speakerDetails[0].realName);
      const isCorrectB = (vote.speakerB === speakerDetails[1].realName);
      if (isCorrectA) correctA++;
      if (isCorrectB) correctB++;

      voteResults.push({
        voterName,
        guessA: vote.speakerA,
        guessB: vote.speakerB,
        correctA: isCorrectA,
        correctB: isCorrectB
      });
    });

    const resultData = {
      speakers: speakerDetails,
      messages: room.messages,
      votes: voteResults,
      totalVotes: voteEntries.length,
      correctCountA: correctA,
      correctCountB: correctB
    };

    // 向房间内所有人广播结果
    io.to(roomId).emit("gameEnded", resultData);

    // 重置游戏状态
    room.gameStarted = false;
    room.speakers = [];
    room.anonymousMap = {};
    room.messages = [];
    room.votes = {};

    io.to(roomId).emit("gameStateChanged", { gameStarted: false });
    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const userIndex = room.users.findIndex(u => u.socketId === socket.id);
    if (userIndex !== -1) {
      const userName = room.users[userIndex].name;
      room.users.splice(userIndex, 1);

      // 如果游戏进行中且发言者离开，自动结束并展示当前结果
      if (room.gameStarted && room.speakers.includes(socket.id)) {
        // 提前结束游戏
        const speakerA = room.users.find(u => u.socketId === room.speakers[0]);
        const speakerB = room.users.find(u => u.socketId === room.speakers[1]);
        const speakerDetails = [
          { anonymousName: "匿名A", realName: speakerA ? speakerA.name : "已离开" },
          { anonymousName: "匿名B", realName: speakerB ? speakerB.name : "已离开" }
        ];
        io.to(roomId).emit("gameEnded", {
          speakers: speakerDetails,
          messages: room.messages,
          votes: [],
          totalVotes: 0,
          correctCountA: 0,
          correctCountB: 0
        });
        room.gameStarted = false;
        room.speakers = [];
        room.anonymousMap = {};
        room.messages = [];
        room.votes = {};
        io.to(roomId).emit("gameStateChanged", { gameStarted: false });
      }

      io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));

      if (room.users.length === 0) {
        delete rooms[roomId];
        console.log(`房间 ${roomId} 已删除`);
      } else {
        console.log(`${userName} 离开房间 ${roomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
