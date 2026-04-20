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

// 生成6位房间号
function generateRoomId() {
  return uuidv4().substring(0, 6).toUpperCase();
}

io.on("connection", (socket) => {
  console.log("用户连接:", socket.id);

  // 创建房间
  socket.on("createRoom", () => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      id: roomId,
      users: [],            // { id, name, socketId }
      gameStarted: false,
      speakers: [],          // 发言者的 socket.id 数组
      anonymousMap: {},      // socketId -> "匿名A" 或 "匿名B"
      messages: [],          // 游戏过程中的匿名消息
      preGameMessages: [],   // 游戏前的公开消息
      votes: {},             // 投票数据: voterSocketId -> { speakerA: guessedName, speakerB: guessedName }
      creator: socket.id
    };
    socket.emit("roomCreated", roomId);
    console.log(`房间 ${roomId} 已创建`);
  });

  // 加入房间（带姓名）
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
    // 检查是否已在房间
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

    // 发送加入成功
    socket.emit("joinSuccess", {
      roomId,
      userName: trimmedName,
      isCreator: room.creator === socket.id,
      users: room.users.map(u => ({ id: u.id, name: u.name }))
    });

    // 广播用户列表更新
    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));

    // 发送游戏前的历史消息
    socket.emit("preGameHistory", room.preGameMessages);

    console.log(`${trimmedName} 加入房间 ${roomId}`);
  });

  // 公开聊天（游戏前）
  socket.on("publicMessage", (msg) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已开始，请使用匿名发言");
      return;
    }
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

  // 开始游戏
  socket.on("startGame", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已经开始了");
      return;
    }
    if (room.users.length < 2) {
      socket.emit("errorMsg", "至少需要2人才能开始");
      return;
    }

    room.gameStarted = true;

    // 随机选2个发言者
    const shuffled = [...room.users].sort(() => 0.5 - Math.random());
    const selectedSpeakers = shuffled.slice(0, 2);
    room.speakers = selectedSpeakers.map(s => s.socketId);

    // 分配匿名代号
    room.anonymousMap = {};
    room.anonymousMap[selectedSpeakers[0].socketId] = "匿名A";
    room.anonymousMap[selectedSpeakers[1].socketId] = "匿名B";

    // 初始化投票数据结构
    room.votes = {};

    // 清空游戏内消息
    room.messages = [];

    // 通知每个客户端
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
        allUsers: room.users.map(u => ({ id: u.id, name: u.name })) // 用于投票下拉
      });
    });

    io.to(roomId).emit("gameStateChanged", { gameStarted: true });
  });

  // 游戏中匿名发言（仅发言者）
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

  // 投票
  socket.on("submitVote", ({ guessForA, guessForB }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.gameStarted) {
      socket.emit("errorMsg", "游戏未开始");
      return;
    }
    // 发言者不能投票
    if (room.speakers.includes(socket.id)) {
      socket.emit("errorMsg", "发言者不能投票");
      return;
    }

    // 验证猜测的姓名是否在房间用户中
    const userNames = room.users.map(u => u.name);
    if (!userNames.includes(guessForA) || !userNames.includes(guessForB)) {
      socket.emit("errorMsg", "无效的投票选项");
      return;
    }

    room.votes[socket.id] = {
      speakerA: guessForA,   // 对应匿名A的真实姓名
      speakerB: guessForB     // 对应匿名B的真实姓名
    };

    socket.emit("voteConfirmed");
    console.log(`${socket.id} 投票: A->${guessForA}, B->${guessForB}`);
  });

  // 结束游戏
  socket.on("endGame", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.gameStarted) return;

    // 获取发言者真实信息
    const speakerDetails = room.speakers.map(sockId => {
      const user = room.users.find(u => u.socketId === sockId);
      return {
        socketId: sockId,
        realName: user ? user.name : "未知",
        anonymousName: room.anonymousMap[sockId]
      };
    });

    // 整理投票结果
    const voteResults = [];
    const correctVotes = { A: 0, B: 0 };
    const totalVotes = Object.keys(room.votes).length;

    Object.entries(room.votes).forEach(([voterId, vote]) => {
      const voter = room.users.find(u => u.socketId === voterId);
      const voterName = voter ? voter.name : "未知";
      const speakerAReal = speakerDetails.find(s => s.anonymousName === "匿名A")?.realName;
      const speakerBReal = speakerDetails.find(s => s.anonymousName === "匿名B")?.realName;

      const isACorrect = (vote.speakerA === speakerAReal);
      const isBCorrect = (vote.speakerB === speakerBReal);
      if (isACorrect) correctVotes.A++;
      if (isBCorrect) correctVotes.B++;

      voteResults.push({
        voterName,
        guessA: vote.speakerA,
        guessB: vote.speakerB,
        correctA: isACorrect,
        correctB: isBCorrect
      });
    });

    const resultData = {
      speakers: speakerDetails.map(s => ({ realName: s.realName, anonymousName: s.anonymousName })),
      messages: room.messages,
      votes: voteResults,
      totalVotes,
      correctCountA: correctVotes.A,
      correctCountB: correctVotes.B
    };

    io.to(roomId).emit("gameEnded", resultData);

    // 重置游戏状态
    room.gameStarted = false;
    room.speakers = [];
    room.anonymousMap = {};
    room.messages = [];
    room.votes = {};
    // 保留 preGameMessages，不清除

    io.to(roomId).emit("gameStateChanged", { gameStarted: false });
    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
  });

  // 断开连接
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const userIndex = room.users.findIndex(u => u.socketId === socket.id);
    if (userIndex !== -1) {
      const userName = room.users[userIndex].name;
      room.users.splice(userIndex, 1);

      // 如果游戏进行中且发言者离开，自动结束游戏
      if (room.gameStarted && room.speakers.includes(socket.id)) {
        // 提前结束并公布结果（简化处理）
        io.to(roomId).emit("errorMsg", "发言者离开，游戏提前结束");
        // 直接调用结束逻辑（简化版）
        const speakerDetails = room.speakers.map(sockId => {
          const user = room.users.find(u => u.socketId === sockId);
          return {
            realName: user ? user.name : "已离开",
            anonymousName: room.anonymousMap[sockId] || "匿名"
          };
        });
        io.to(roomId).emit("gameEnded", {
          speakers: speakerDetails,
          messages: room.messages,
          votes: [],
          totalVotes: 0
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
