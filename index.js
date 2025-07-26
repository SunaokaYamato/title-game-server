const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = 4001;
const MAX_TURNS = 4;

// ✅ カード一覧の読み込み（cards.json を参照）
const cardsPath = path.join(__dirname, 'cards.json');
const allCards = JSON.parse(fs.readFileSync(cardsPath, 'utf-8'));

const rooms = {};

// ✅ 新規ルームテンプレート
function createNewRoom() {
  return {
    players: [],
    votes: {},
    votedPlayers: [],
    readyPlayers: [],
    turn: 1,
    submissions: [],
    deck: [...allCards].sort(() => Math.random() - 0.5),
    hands: {}
  };
}

function removePlayerFromRoom(roomId, playerName) {
  const room = rooms[roomId];
  if (!room) return;

  room.players = room.players.filter((n) => n !== playerName);
  room.votedPlayers = room.votedPlayers.filter((n) => n !== playerName);
  room.readyPlayers = room.readyPlayers.filter((n) => n !== playerName);
  delete room.votes[playerName];
  delete room.hands[playerName];
  room.submissions = room.submissions.filter((t) => t.playerName !== playerName);
}

// ✅ 指定枚数カードを引く
function drawCards(deck, count) {
  return deck.splice(0, count);
}

// 🎮 ソケット接続処理
io.on('connection', (socket) => {
  console.log(`🟢 クライアント接続: ${socket.id}`);

  socket.on('join-room', ({ roomId, playerName }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = createNewRoom();
    }

    const room = rooms[roomId];
    removePlayerFromRoom(roomId, playerName);
    room.players.push(playerName);
    socket.data = { roomId, playerName };

    const hand = drawCards(room.deck, 7);
    room.hands[playerName] = hand;
    socket.emit('deal-hand', hand);

    io.to(roomId).emit('players-in-room', room.players);
    console.log(`👥 ${playerName} がルーム ${roomId} に参加`);
  });

  // ✅ タイトル提出（使用カード含む）
  socket.on('submit-title', ({ roomId, playerName, title, usedCards }) => {
    const room = rooms[roomId];
    if (!room) return;

    // ✅ usedCards が不正なら弾く
    if (!Array.isArray(usedCards) || usedCards.length !== 2) {
      console.warn(`❌ 無効な usedCards（${playerName}）:`, usedCards);
      return;
    }

    console.log('📩 submit-title 受信:', playerName, 'usedCards:', usedCards);
    room.submissions = room.submissions.filter((t) => t.playerName !== playerName);

    room.submissions.push({
      playerName,
      title,
      turn: room.turn,
      votes: 0,
      usedCards
    });

    io.to(roomId).emit('title-submitted', { playerName, title });
  });

  // ✅ 投票処理
  socket.on('vote', ({ roomId, playerName, targetName }) => {
    const room = rooms[roomId];
    if (!room) return;

    console.log(`🗳️ 投票: ${targetName} に投票`);
    room.votes[targetName] = (room.votes[targetName] || 0) + 1;
    room.votedPlayers.push(playerName);

    const targetTitle = room.submissions.find(t => t.playerName === targetName);
    if (targetTitle) {
      targetTitle.votes = (targetTitle.votes || 0) + 1;
    }

    if (room.votedPlayers.length === room.players.length) {
      io.to(roomId).emit('all-voted');
    }
  });

  // ✅ カードを1枚捨てて、山札から1枚補充
  socket.on('discard-card', ({ roomId, playerName, card }) => {
    const room = rooms[roomId];
    if (!room) return;

    const playerHand = room.hands[playerName];
    if (!playerHand || !playerHand.includes(card)) return;

    room.hands[playerName] = playerHand.filter(c => c !== card);

    if (room.deck.length === 0) {
      console.log(`🌀 山札が空！カード補充ロジックが必要`);
      return;
    }

    const newCard = room.deck.shift();
    room.hands[playerName].push(newCard);

    io.to(socket.id).emit('deal-hand', room.hands[playerName]);
    console.log(`🔁 ${playerName} に新しいカードを補充`);
  });

  // ✅クライアントからの手札リクエストに応えて現在の手札を返す
  socket.on('request-hand', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (room && room.hands[playerName]) {
      socket.emit('deal-hand', room.hands[playerName]);
    }
  });

  // ✅ 次ターンへの準備完了通知
  socket.on('ready-for-next-turn', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (!room.readyPlayers.includes(playerName)) {
      room.readyPlayers.push(playerName);
      io.to(roomId).emit('player-ready-next', playerName);
    }

    // ✅ 全員がreadyになったら1回だけ進行
    if (room.readyPlayers.length === room.players.length) {
      if (room._turnProcessed !== room.turn) {  // ← 追加：同じターン内で二重処理防止
        room._turnProcessed = room.turn;

        // 🔄 ターン処理
        for (const { playerName, usedCards } of room.submissions) {
          const hand = room.hands[playerName] || [];
          const used = Array.isArray(usedCards) ? usedCards : []; 
          const newHand = hand.filter(card => !used.includes(card));
          const needed = 7 - newHand.length;
          const drawn = drawCards(room.deck, needed);
          room.hands[playerName] = [...newHand, ...drawn];

          console.log(`🛠️ ${playerName} 手札更新:`, room.hands[playerName]);

          const socketId = [...io.sockets.sockets.entries()]
            .find(([_, s]) => s.data.playerName === playerName && s.data.roomId === roomId)?.[0];
          if (socketId) {
            io.to(socketId).emit('deal-hand', room.hands[playerName]);
          } else {
            console.log(`⚠️ ${playerName} の socket が見つかりません`);
          }
        }

        // 次ターン準備
        room.turn += 1;
        room.votes = {};
        room.votedPlayers = [];
        room.readyPlayers = [];
        room.submissions = [];

        io.to(roomId).emit('next-turn', room.turn);
        // 各プレイヤーに補充後の手札を再送信
        for (const player of room.players) {
         // player に対応する socket.id を探す
         const socketId = [...io.sockets.sockets.entries()]
           .find(([_, s]) =>
             s.data.roomId === roomId && s.data.playerName === player
           )?.[0];
         if (socketId) {
           io.to(socketId).emit('deal-hand', room.hands[player]);
         }
       }
      }
    }
  });

  // ✅ 切断処理
  socket.on('disconnect', () => {
    const { roomId, playerName } = socket.data || {};
    if (roomId && playerName) {
      removePlayerFromRoom(roomId, playerName);
      io.to(roomId).emit('players-in-room', rooms[roomId]?.players || []);
      console.log(`🔴 切断: ${playerName}（${socket.id}）`);
    }
  });
});

// ✅ サーバー起動
server.listen(PORT, () => {
  console.log(`🚀 サーバー起動完了：http://localhost:${PORT}`);
});
