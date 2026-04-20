const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static("public"));

// 存储所有房间信息
const rooms = {};

// 生成随机匿名昵称
const generateAnonymousName = () => {
  return "匿名" + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
};

io.on("connection", (socket) => {
  console.log("用户连接:", socket.id);

  // 创建房间
  socket.on("createRoom", () => {
    const roomId = uuidv4().substring(0, 6).toUpperCase(); // 生成6位房间号
    rooms[roomId] = {
      id: roomId,
      users: [],
      gameStarted: false,
      speakers: [],
      messages: [],
      creator: socket.id
    };
    
    socket.emit("roomCreated", roomId);
    console.log(`房间 ${roomId} 已创建`);
  });

  // 加入房间
  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    
    // 房间不存在
    if (!room) {
      socket.emit("errorMsg", "房间不存在");
      return;
    }

    // 游戏已开始，禁止加入
    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已开始，无法加入");
      return;
    }

    // 检查是否已在房间中（防止重复加入）
    const existingUser = room.users.find(u => u.id === socket.id);
    if (existingUser) {
      socket.emit("errorMsg", "你已经在房间中");
      return;
    }

    const user = {
      id: socket.id,
      name: generateAnonymousName()
    };

    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = user.name;

    // 通知房间内所有人更新用户列表
    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
    
    // 发送加入成功消息
    socket.emit("joinSuccess", { 
      roomId, 
      userName: user.name,
      isCreator: room.creator === socket.id
    });
    
    console.log(`${user.name} 加入房间 ${roomId}`);
  });

  // 开始游戏
  socket.on("startGame", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    
    const room = rooms[roomId];
    if (!room) return;
    
    // 检查游戏状态
    if (room.gameStarted) {
      socket.emit("errorMsg", "游戏已经开始了");
      return;
    }

    // 检查人数（至少需要2人）
    if (room.users.length < 2) {
      socket.emit("errorMsg", "至少需要2人才能开始游戏");
      return;
    }

    // 标记游戏开始
    room.gameStarted = true;
    
    // 随机挑选2个不同的发言者
    const shuffled = [...room.users].sort(() => 0.5 - Math.random());
    room.speakers = shuffled.slice(0, 2).map(u => u.id);
    
    // 清空之前的消息记录
    room.messages = [];
    
    // 为每个客户端单独发送游戏开始事件，告知其是否为发言者
    room.users.forEach(user => {
      const isSpeaker = room.speakers.includes(user.id);
      io.to(user.id).emit("gameStarted", { 
        isSpeaker,
        totalPlayers: room.users.length
      });
    });
    
    // 广播游戏状态（用于更新UI）
    io.to(roomId).emit("gameStateChanged", { gameStarted: true });
    
    console.log(`房间 ${roomId} 游戏开始，发言者: ${room.speakers.map(id => {
      const u = room.users.find(u => u.id === id);
      return u ? u.name : id;
    }).join(', ')}`);
  });

  // 发送消息
  socket.on("sendMessage", (msg) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    
    // 验证是否为发言者
    if (!room.speakers.includes(socket.id)) {
      socket.emit("errorMsg", "你已被禁言");
      return;
    }

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    const message = {
      senderId: socket.id,
      senderName: user.name,
      text: msg,
      timestamp: Date.now()
    };

    room.messages.push(message);
    
    // 广播消息给房间内所有人
    io.to(roomId).emit("newMessage", {
      text: msg,
      isSpeaker: true, // 标记为发言者消息
      timestamp: message.timestamp
    });
  });

  // 结束游戏
  socket.on("endGame", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    // 准备结果数据
    const speakerDetails = room.speakers.map(speakerId => {
      const user = room.users.find(u => u.id === speakerId);
      return user ? { id: user.id, name: user.name } : null;
    }).filter(Boolean);

    const resultData = {
      speakers: speakerDetails,
      messages: room.messages.map(m => ({
        text: m.text,
        senderName: m.senderName,
        timestamp: m.timestamp
      }))
    };

    // 广播游戏结束及结果
    io.to(roomId).emit("gameEnded", resultData);
    
    // 重置游戏状态
    room.gameStarted = false;
    room.speakers = [];
    room.messages = [];
    
    // 通知所有人更新用户列表
    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
    io.to(roomId).emit("gameStateChanged", { gameStarted: false });
    
    console.log(`房间 ${roomId} 游戏结束`);
  });

  // 断开连接处理
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    
    const room = rooms[roomId];
    const userIndex = room.users.findIndex(u => u.id === socket.id);
    
    if (userIndex !== -1) {
      const userName = room.users[userIndex].name;
      room.users.splice(userIndex, 1);
      
      // 如果游戏正在进行且发言者离开，自动结束游戏
      if (room.gameStarted && room.speakers.includes(socket.id)) {
        io.to(roomId).emit("errorMsg", "发言者离开，游戏自动结束");
        
        // 准备结果（即使提前结束也展示当前结果）
        const speakerDetails = room.speakers.map(speakerId => {
          const user = room.users.find(u => u.id === speakerId);
          return user ? { id: user.id, name: user.name } : { id: speakerId, name: "已离开" };
        });
        
        io.to(roomId).emit("gameEnded", {
          speakers: speakerDetails,
          messages: room.messages.map(m => ({
            text: m.text,
            senderName: m.senderName,
            timestamp: m.timestamp
          }))
        });
        
        room.gameStarted = false;
        room.speakers = [];
        room.messages = [];
        io.to(roomId).emit("gameStateChanged", { gameStarted: false });
      }
      
      // 更新用户列表
      io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
      
      // 如果房间没人了，删除房间
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
