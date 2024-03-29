import { io } from "./index";
import * as game from "./game";
import * as match from "./match";
import * as shared from "../shared";

let nextPlayerId = 0;
function getNextPlayerId() {
  return (nextPlayerId++).toString();
}

export default class Player {
  pub: Game.PlayerPub;

  constructor(public socket: SocketIO.Socket) {
    this.pub = { id: getNextPlayerId(), name: `Guest${Math.floor(1000 + Math.random() * 9000)}`, avatar: null };
    game.pub.players.push(this.pub);
    game.players.byId[this.pub.id] = this;
    game.players.all.push(this);

    io.in("game").emit("addPlayer", this.pub);
    this.socket.join("game");

    socket.on("chat", this.onChat);
    socket.on("setName", this.onSetName);
    socket.on("joinTeam", this.onJoinTeam);
    socket.on("input", this.onInput);
    socket.on("throwBall", this.onThrowBall);
    socket.on("disconnect", this.onDisconnect);

    socket.emit("welcome", game.pub, this.pub.id);
  }

  private onChat = (text: string, callback: Game.ErrorCallback) => {
    if (typeof text !== "string" || text.length < 1 || text.length > 300) { callback("Invalid chat message."); return; }

    io.in("game").emit("chat", this.pub.id, text);
  };

  private onSetName = (name: string, callback: Game.ErrorCallback) => {
    if (typeof name !== "string" || name.length < 1 || name.length > 20) { callback("Invalid name."); return; }

    io.in("game").emit("setName", this.pub.id, name);
    this.pub.name = name;
    callback(null);
  };

  private onJoinTeam = (teamIndex: number, callback: Game.ErrorCallback) => {
    if (this.pub.avatar != null) { this.socket.disconnect(); return; }
    if (typeof teamIndex !== "number") { this.socket.disconnect(); return; }

    const team = game.teams[teamIndex];
    if (team == null) { this.socket.disconnect(); return; }
    if (team.players.length === shared.maxPlayersPerTeam) { callback("Team is full."); return; }

    // Setup avatar and team
    const x = teamIndex === 0 ? -5 : 5;
    const z = (team.players.length - 1) * 3;
    const angleY = teamIndex === 0 ? 0 : Math.PI;
    this.pub.avatar = { teamIndex, score: 0, x, z, jump: { timer: 0, withBall: false }, angleX: 0, angleY, catching: false };
    team.players.push(this);

    // Add to active players list
    game.players.active.push(this);

    // Add to room
    this.socket.join(`game:team:${teamIndex}`);

    // Let everyone know
    io.in("game").emit("joinTeam", this.pub.id, this.pub.avatar);

    // Launch match
    const playersByTeam: { [teamIndex: number]: number; } = { 0: 0, 1: 0 };
    game.players.all.forEach((x) => { if (x.pub.avatar != null) playersByTeam[x.pub.avatar.teamIndex]++; });

    if (game.pub.match == null && playersByTeam[0] > 0 && playersByTeam[1] > 0) {
      match.start();
    }

    callback(null);
  };

  tick() {
    const avatar = this.pub.avatar;
    if (avatar.jump.timer > 0) avatar.jump.timer--;
  }

  private onInput = (input: Game.PlayerInput) => {
    const avatar = this.pub.avatar;
    if (avatar == null) return;

    const ball = game.pub.ball;
    const hasBall = ball.playerId === this.pub.id;

    if (game.pub.match != null && !hasBall) {
      // TODO: Validate that move is possible in timeframe
      avatar.x = input.x;
      avatar.z = input.z;
    }

    if (input.jumping && avatar.jump.timer === 0) {
      avatar.jump.timer = hasBall ? shared.jump.durationWithBall : shared.jump.durationNoBall;
      avatar.jump.withBall = hasBall;
    }

    avatar.angleX = input.angleX;
    avatar.angleY = input.angleY;

    avatar.catching = ball.playerId == null && input.catching;

    if (game.pub.match != null && game.pub.match.scoreTimer === 0 && avatar.catching) {
      const arm = shared.getArmPosition(avatar);
      const dx = ball.x - arm.x;
      const dz = ball.z - arm.z;

      const dy = (ball.y > shared.shoulderY || avatar.jump.timer !== 0) ? ball.y - arm.y : 0;

      if (Math.sqrt(dx * dx + dz * dz + dy * dy) <= shared.ballPhysics.catchRadius) {
        ball.playerId = game.lastBallPlayerId = this.pub.id;
        io.in("game").emit("catchBall", ball.playerId);
      }
    }
  };

  private onThrowBall = () => {
    const avatar = this.pub.avatar;
    if (avatar == null) return;

    const ball = game.pub.ball;
    if (ball.playerId !== this.pub.id) return;

    const arm = shared.getArmPosition(avatar);
    ball.playerId = null;

    const throwPower = 0.3;
    ball.x = arm.x;
    ball.y = arm.y;
    ball.z = arm.z;

    ball.vx = Math.cos(avatar.angleY) * (1 + Math.cos(avatar.angleX)) * throwPower;
    ball.vz = Math.sin(avatar.angleY) * (1 + Math.cos(avatar.angleX)) * throwPower;

    ball.vy = Math.sin(avatar.angleX) * throwPower;

    ball.playerId = null;
    io.in("game").emit("throwBall", ball);
  };

  private onDisconnect = () => {
    if (this.pub.avatar != null) {
      if (game.pub.ball.playerId === this.pub.id) this.onThrowBall();

      game.players.active.splice(game.players.active.indexOf(this), 1);

      const team = game.teams[this.pub.avatar.teamIndex];
      team.players.splice(team.players.indexOf(this), 1);
    }

    game.pub.players.splice(game.pub.players.indexOf(this.pub), 1);
    delete game.players.byId[this.pub.id];
    game.players.all.splice(game.players.all.indexOf(this), 1);

    io.in("game").emit("removePlayer", this.pub.id);

    if (game.pub.match != null && game.players.active.length <= 1) {
      match.end();
    }
  };
}
