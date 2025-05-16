// const socket = io();
// const cursors = {};
// const myColor = `hsl(${Math.random() * 360}, 100%, 50%)`;

// document.addEventListener("mousemove", (e) => {
//   socket.emit("cursorMove", {
//     x: e.clientX,
//     y: e.clientY,
//     color: myColor,
//   });

//   drawCursor(socket.id, e.clientX, e.clientY, myColor);
// });

// socket.on("playerMoved", ({ id, x, y, color }) => {
//   drawCursor(id, x, y, color);
// });

// socket.on("playerDisconnected", (id) => {
//   if (cursors[id]) {
//     document.body.removeChild(cursors[id]);
//     delete cursors[id];
//   }
// });

// function drawCursor(id, x, y, color) {
//   let cursor = cursors[id];
//   if (!cursor) {
//     cursor = document.createElement("div");
//     cursor.classList.add("cursor");
//     cursor.style.backgroundColor = color;
//     document.body.appendChild(cursor);
//     cursors[id] = cursor;
//   }
//   cursor.style.transform = `translate(${x}px, ${y}px)`;
// }