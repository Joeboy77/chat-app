# Chat Room Application

A real-time chat application that allows users to join chat rooms with just a username. Users can see who's online, exchange text messages, send voice recordings, and share files.

## Features

- **Simple Authentication**: Join with just a username
- **Real-time Messaging**: Instant message delivery
- **Active Users List**: See who's currently online
- **Voice Messages**: Record and send audio messages
- **File Sharing**: Exchange files with other users
- **Responsive Design**: Works on desktop and mobile devices

## Tech Stack

- **Frontend**: React.js
- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Real-time Communication**: Socket.io



## Prerequisites

- Node.js (v14.0.0 or later)
- npm or yarn
- PostgreSQL (v12 or later)

## Installation

### 1. Extract the application files

```bash
unzip chat-room-app.zip

cd chat-room-app
```

### 2. Set up the backend

```bash
cd server
npm install

touch .env
```

Add the following to your `.env` file:

```
PORT=8080
DATABASE_URL=postgres://userchat:National66715@localhost:5432/chatdb
```

### 3. Set up the database

```bash
psql -U postgres
CREATE DATABASE chatapp;
```

### 5. Set up the frontend

```bash
cd ../client
yarn install
```

## Running the Application

### 1. Start the backend server

```bash
cd server
npm run dev
```

### 2. Start the frontend application

```bash
cd client
npm start
```

The application should now be running at `http://localhost:3000`.


### Backend

```bash
cd server
node server
npm start
```

### Frontend

```bash
cd client
npm start
```

