# Duel Room

Two phones, one room code, fourteen quick games, plus a 5-game tournament.
Everything runs from this folder: a tiny Node server (no dependencies, needs Node 18 or newer) plus an installable web app (PWA).

Games: Tic-Tac-Toe, Drop Four, Rock Paper Scissors, Tap Duel, Quick Math, Ping Pong, Air Hockey,
Snake Duel, Sumo Push, Penalty Kicks, Guess the Person, Odd One Out, Cornhole, Bowling.

## Run it on your computer (both phones on the same Wi-Fi)

    npm start

Open `http://<your-computer-ip>:3000` on both phones. One taps Create a room, the other taps Join and enters the code.
This plays in the browser. Installing as an app needs HTTPS, so use the hosted option below for that.

## Put it online (free) so you can install it as an app

Render (render.com), about 5 minutes. The included `render.yaml` fills in the settings for you (a `Dockerfile` is included for hosts that prefer one):
1. Put this folder in a GitHub repository.
2. In Render choose New, then Web Service, and pick the repository.
3. Build command: leave empty or `echo ok` (there is nothing to install). Start command: `npm start`. Pick the free plan.
4. Open the URL Render gives you on both phones.

The free plan sleeps when idle, so the first load after a break can take up to a minute.
Railway, Fly.io and any host that runs Node 18+ with WebSockets also work.

## Install it as an app

- Android (Chrome): open your hosted URL, then menu, Install app (or Add to Home screen).
- iPhone (Safari): open the URL, tap Share, then Add to Home Screen.
- A real Android APK: go to pwabuilder.com, paste your hosted URL and download the Android package.

## How it works

The host's phone runs the game and the server only forwards messages between the two players in a room
(rooms hold up to 8 connections, messages are limited to 4 KB, and nothing is stored).
Fast games (Air Hockey, Ping Pong, Sumo, Snake) are smoothest when the host has a good connection and keeps the screen on.
