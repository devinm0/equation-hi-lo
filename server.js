const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

class Player {
    constructor(id, username, hand) {
        this.id = id;
        this.username = username;
        this.hand = hand;
    }
}
let players = new Map();

const NumberCards = {
    ZERO: "zero",
    ONE: "one",
    TWO: "two",
    THREE: "three",
    FOUR: "four",
    FIVE: "five",
    SIX: "six",
    SEVEN: "seven",
    EIGHT: "eight",
    NINE: "nine",
    TEN: "ten"
}

const OperatorCards = {
    ADD: "add",
    SUBTRACT: "subtract",
    DIVIDE: "divide",
    MULTIPLY: "multiply",
    ROOT: "root",
};

const Suits = {
    GOLD: "gold",
    SILVER: "silver",
    BRONZE: "bronze",
    STONE: "stone"
}

class Card {
    constructor(value, suit) {
        this.value = value;
        this.suit = suit;
    }
}
let deck = []
// add all numbers of all suits to deck
for (const number in NumberCards) {
    if (NumberCards.hasOwnProperty(number)) { // Check if the property belongs to the object itself

      for (const suit in Suits) {
        if (Suits.hasOwnProperty(suit)) { // Check if the property belongs to the object itself
            deck.push(new Card(number, suit));
        }
      }
    }
}
// add 5 each of multiply and root cards to deck
for (let i = 0; i < 4; i++) {
    deck.push(new Card(OperatorCards.MULTIPLY, 'operator'));
    deck.push(new Card(OperatorCards.ROOT, 'operator'));
}

deck.sort(() => Math.random() - 0.5);

console.log(deck);
let hostId = null;

app.use(express.static("public"));

// still not clear whether we use myColor or just color from the 
// messages. is all code inside connection block here
// as if it's one "user"? 
// difference between wss and ws
wss.on("connection", (ws) => {
    // ahhh, i guess the ws represents this one user's conenction
  const userId = uuidv4();
  ws.userId = userId; // Store on socket
  
  if (!hostId) { // ! applies to null!?
    hostId = userId;
    ws.isHost = true;
    console.log("hostId is " + hostId);
  }

  const userColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
  // need to remove this... it's a user that never gets used
  // only log it if socket message comes BACK
  console.log(`User connected: ${userId}`);

  console.log(players);
  // Send init message with the userId
  ws.send(JSON.stringify({ type: "init", id: userId, color: userColor, isHost: ws.isHost || false }));


  // without this, we don't see the other cursors at the start. but even with it, they appear top corner to start
//   players.forEach((value, key) => {
//     const payload = JSON.stringify({
//         type: "cursor",
//         id: key,
//         x: value.x,
//         y: value.y,
//         color: value.color,
//       });
//       ws.send(payload);
//   })

  ws.on("message", (message) => {
    // console.log("message");
    const str = message.toString();
    let data;

    try {
      data = JSON.parse(str);
    } catch {
      return;
    }

    // Forward cursor messages to others
    if (data.type === "cursor") {
        // players.set(userId, {x: data.x, y: data.y, color: data.color});

      // why aren't we using userId instead of data.Id here?
      const payload = JSON.stringify({
        type: "cursor",
        id: data.id,
        x: data.x,
        y: data.y,
        color: data.color,
        username: data.username
      });

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }

    
    if (data.type === "start" /*&& ws.userId === hostId*/) { // should I check isHost instead?
        console.log("150" + ws.userId + " " + hostId);
        const payload = JSON.stringify({ type: "game-started" });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });

        initializeGame(ws);

        dealFirstHiddenCardToEachPlayer(ws); // okay so ws is whoever started the game
    
        dealTwoOpenCardsToEachPlayer(ws); // okay so ws is whoever started the game
    }

    if (data.type === "leave") {
        if (ws.userId === hostId) {
            // set a new host. if last player, end the game
        }
        const payload = JSON.stringify({ type: "player-left" });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });

        players.delete(ws.userId); //ws.userId or userId??
        console.log(`User disconnected: ${ws.userId}`);
    }

    if (data.type === "join") {
        console.log('player actually joined here' + data.username);

        if (ws.isHost) { // without this, later players joining become the host
            // but don't have a start button. so game can't start
            hostId = data.userId; // just use ws.userId here?
        }
        console.log(data.userId + " " + hostId);
        ws.userId = data.userId;
        hostId = data.userId;
        console.log(hostId + " " + ws.userId);
        // need a null check on players[data.id] here
        players.set(data.userId, new Player(data.userId, data.username, []));

        console.log(data.userId);
            // notify other players of joining
        const payload = JSON.stringify({
            type: "player-joined",
            //id: data.id,
            //x: data.x,
            //y: data.y,
            isHost: ws.isHost,
            color: data.color, // what happens if we put user color here?
            username: data.username
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});

function initializeGame(ws) {    // don't need ws
    players.forEach((player, id) => { // why does value come before key. so annoying
        player.hand.push(new Card(OperatorCards.ADD, 'operator'));
        player.hand.push(new Card(OperatorCards.DIVIDE, 'operator'));
        player.hand.push(new Card(OperatorCards.SUBTRACT, 'operator'));

        notifyAllPlayersOfNewlyDealtCards(ws, player);
    })
}

function dealFirstHiddenCardToEachPlayer(ws) {
    players.forEach((player, id) => { // why does value come before key. so annoying
        for (let i = 0; i < deck.length; i++) {
            // cannot be operator card
            if (deck[i].suit !== 'operator') {
                // Remove the card and give it to player
                player.hand.push(deck.splice(i, 1)[0]);
                break; // having to index here is so trash omg
            }
        }

        notifyAllPlayersOfNewlyDealtCards(ws, player);

        console.log("dealt hidden card to " + player.id);
        console.log(player.hand);
    });
}

function dealTwoOpenCardsToEachPlayer(ws) { // could be three if there is a root
    players.forEach((player, id) => { // why does value come before key. so annoying    
        // first card can be any card
        const draw = deck.splice(0, 1)[0];
        player.hand.push(draw);
    
        // technically i should be putting returned cards at the bottom
        // but the math should be the same
        
        // ensure second card is a number
        for (let i = 0; i < deck.length; i++) {
            // cannot be operator card
            if (deck[i].suit !== 'operator') {
                // Remove the card and give it to player
                player.hand.push(deck.splice(i, 1)[0]);
                break; // having to index here is so trash omg
            }
        }

        if (draw.value === 'root') { // push another number
            // TODO modularize this code
            for (let i = 0; i < deck.length; i++) {
                // cannot be operator card
                if (deck[i].suit !== 'operator') {
                    // Remove the card and give it to player
                    player.hand.push(deck.splice(i, 1)[0]);
                    break; // having to index here is so trash omg
                }
            }
        }

        notifyAllPlayersOfNewlyDealtCards(ws, player);

        console.log("dealt hidden card to " + player.id);
        console.log(player.hand);
    });
}

function notifyAllPlayersOfNewlyDealtCards(ws, player) {
    wss.clients.forEach((client) => {
        let payload;
        if (client.userId == player.id) { // need to check if client = username
             payload = JSON.stringify({
                type: "deal",
                id: player.id,
                username: player.username,
                hand: player.hand
              });
            } else {
                // hide the hidden card.
                let handToSend = JSON.parse(JSON.stringify(player.hand));
                handToSend[3] = new Card(null, 'hidden');
                // [...hand] //  only works if contains primitives
             payload = JSON.stringify({
                type: "deal",
                id: player.id,
                username: player.username,
                hand: handToSend // Array. fill with nulls or something
              });
            }

        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
    });
}