const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./db'); 

const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');


dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 120000,
  pingInterval: 30000, 
  transports: ['websocket'], 
  allowUpgrades: false, 
  connectTimeout: 30000 
});

app.get('/', (req, res) => {
  res.send('Chat Room Server is running');
});

const getMessageReactions = async (messageIds) => {
  if (!messageIds || messageIds.length === 0) return [];
  
  try {
    const result = await db.query(`
      SELECT mr.message_id, mr.emoji, u.username
      FROM message_reactions mr
      JOIN users u ON mr.user_id = u.id
      WHERE mr.message_id = ANY($1)
    `, [messageIds]);
    
    return result.rows;
  } catch (error) {
    console.error('Error fetching message reactions:', error);
    return [];
  }
};

const addReactionsToMessages = async (messages) => {
  if (!messages || messages.length === 0) return messages;
  
  const messageIds = messages.map(msg => msg.id);
  const reactions = await getMessageReactions(messageIds);
  
  return messages.map(msg => ({
    ...msg,
    reactions: reactions.filter(r => r.message_id === msg.id)
  }));
};

const activeUsers = new Map();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'audio-' + uniqueSuffix + '.mp3');
  }
});

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'files')
    if(!fs.existsSync(uploadDir)){
      fs.mkdirSync(uploadDir, {recursive: true})
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const fileExt = path.extname(file.originalname);
    const uniqueId = uuidv4();
    cb(null, `${uniqueId}${fileExt}`);
  }
})

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File type not allowed'), false);
  }
};

const uploadFile = multer({
  storage: fileStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, 
  }
});

const upload = multer({ storage: storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/api/upload/file', uploadFile.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    const fileInfo = {
      filename: req.file.originalname,
      fileUrl: `/uploads/files/${req.file.filename}`,
      filePath: req.file.path,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      isImage: req.file.mimetype.startsWith('image/'),
    };
    
    return res.status(200).json(fileInfo);
  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({ message: 'Failed to upload file' });
  }
});

app.post('/api/upload/audio', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file uploaded' });
    }
    
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    
    const audioUrl = `/uploads/${req.file.filename}`;
    return res.status(200).json({ 
      audioUrl, 
      fullUrl: `${baseUrl}${audioUrl}`,
      duration: req.body.duration 
    });
  } catch (error) {
    console.error('Error uploading audio:', error);
    return res.status(500).json({ message: 'Failed to upload audio file' });
  }
});



io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  
  socket.conn.on('packet', (packet) => {
    if (packet.type === 'ping') {
      console.log(`Ping from ${socket.id}`);
    }
  });

  socket.on('join', async (username) => {
    try {
      console.log(`User ${username} joining with socket id ${socket.id}`);
      
      let user;
      const existingUser = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      
      if (existingUser.rows.length > 0) {
        user = existingUser.rows[0];
        console.log('Existing user found:', user);
      } else {
        const newUser = await db.query(
          'INSERT INTO users (username) VALUES ($1) RETURNING *',
          [username]
        );
        user = newUser.rows[0];
        console.log('New user created:', user);
      }
      
      socket.data.user = user;
      activeUsers.set(socket.id, {
        id: user.id,
        username: user.username,
        socketId: socket.id,
        joinedAt: new Date()
      });
      
      socket.emit('joined', user);
      
      io.emit('activeUsers', Array.from(activeUsers.values()));
      
      const messages = await db.query(`
        SELECT m.id, m.content, m.created_at, m.updated_at, 
               m.is_edited, m.is_deleted, m.user_id, u.username
        FROM messages m
        JOIN users u ON m.user_id = u.id
        ORDER BY m.created_at DESC
        LIMIT 50
      `);
      
      console.log(`Sending ${messages.rows.length} messages to new user`);
      
      const messagesWithReactions = await addReactionsToMessages(messages.rows.reverse());
      socket.emit('messageHistory', messagesWithReactions);

      const messageIds = messages.rows.map(msg => msg.id);
      const parentIds = messages.rows.filter(msg => msg.parent_message_id).map(msg => msg.parent_message_id);

      const parentMessages = parentIds.length > 0 ? 
      await db.query(`
        SELECT m.id, m.content, m.type, m.user_id, u.username 
        FROM messages m 
        JOIN users u ON m.user_id = u.id 
        WHERE m.id = ANY($1)
      `, [parentIds]) : { rows: [] };

      const parentMessageMap = new Map();
      parentMessages.rows.forEach(pm => parentMessageMap.set(pm.id, pm));

      const messagesWithParents = messages.rows.map(msg => {
        if (msg.parent_message_id && parentMessageMap.has(msg.parent_message_id)) {
          return {
            ...msg,
            parentMessage: parentMessageMap.get(msg.parent_message_id)
          };
        }
        return msg;
      });

      const messagesWithReactionsAndParents = await addReactionsToMessages(messagesWithParents.reverse());
      socket.emit('messageHistory', messagesWithReactionsAndParents);
      
      socket.broadcast.emit('userJoined', {
        id: user.id,
        username: user.username,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error in join handler:', error);
      socket.emit('error', { message: 'Failed to join the chat. Please try again.' });
    }
  });
  
  socket.on('sendMessage', async (messageData, callback) => {
    try {
      const user = socket.data.user;
      
      if (!user) {
        return callback?.({ message: 'You must be logged in to send messages.' });
      }
      
      if (!messageData.content || messageData.content.trim() === '') {
        return callback?.({ message: 'Message cannot be empty.' });
      }
      
      console.log(`User ${user.username} sending message: ${messageData.content}`);
      
      const newMessage = await db.query(
        'INSERT INTO messages (user_id, content) VALUES ($1, $2) RETURNING *',
        [user.id, messageData.content]
      );
      
      const message = {
        ...newMessage.rows[0],
        username: user.username,
        reactions: [] 
      };
      
      console.log('Message saved to database:', message.id);
      
      io.emit('newMessage', message);
      
      callback?.();
    } catch (error) {
      console.error('Error sending message:', error);
      callback?.({ message: 'Failed to send message. Please try again.' });
    }
  });
  
  socket.on('editMessage', async (data, callback) => {
    try {
      const { messageId, content } = data;
      const user = socket.data.user;
      
      if (!user) {
        const error = { message: 'You must be logged in to edit messages.' };
        socket.emit('error', error);
        return callback?.(error);
      }
      
      const messageCheck = await db.query(
        'SELECT * FROM messages WHERE id = $1',
        [messageId]
      );
      
      if (messageCheck.rows.length === 0) {
        const error = { message: 'Message not found.' };
        socket.emit('error', error);
        return callback?.(error);
      }
      
      if (messageCheck.rows[0].user_id !== user.id) {
        const error = { message: 'You can only edit your own messages.' };
        socket.emit('error', error);
        return callback?.(error);
      }

      const updatedMessage = await db.query(
        `UPDATE messages 
         SET content = $1, updated_at = CURRENT_TIMESTAMP, is_edited = TRUE 
         WHERE id = $2 RETURNING *`,
        [content, messageId]
      );
      
      const reactions = await getMessageReactions([messageId]);
      
      const message = {
        ...updatedMessage.rows[0],
        username: user.username,
        reactions: reactions
      };
      
      io.emit('messageUpdated', message);
      
      callback?.();
    } catch (error) {
      console.error('Error editing message:', error);
      const errorMsg = { message: 'Failed to edit message. Please try again.' };
      socket.emit('error', errorMsg);
      callback?.(errorMsg);
    }
  });
  
  socket.on('deleteMessage', async (data, callback) => {
    try {
      const { messageId } = data;
      const user = socket.data.user;
      
      if (!user) {
        const error = { message: 'You must be logged in to delete messages.' };
        socket.emit('error', error);
        return callback?.(error);
      }
      
      const messageCheck = await db.query(
        'SELECT * FROM messages WHERE id = $1',
        [messageId]
      );
      
      if (messageCheck.rows.length === 0) {
        const error = { message: 'Message not found.' };
        socket.emit('error', error);
        return callback?.(error);
      }
      
      if (messageCheck.rows[0].user_id !== user.id) {
        const error = { message: 'You can only delete your own messages.' };
        socket.emit('error', error);
        return callback?.(error);
      }
      
      const deletedMessage = await db.query(
        'UPDATE messages SET is_deleted = TRUE WHERE id = $1 RETURNING *',
        [messageId]
      );
      
      const reactions = await getMessageReactions([messageId]);
      
      const message = {
        ...deletedMessage.rows[0],
        username: user.username,
        reactions: reactions
      };
      
      io.emit('messageDeleted', message);
      
      callback?.();
    } catch (error) {
      console.error('Error deleting message:', error);
      const errorMsg = { message: 'Failed to delete message. Please try again.' };
      socket.emit('error', errorMsg);
      callback?.(errorMsg);
    }
  });

   socket.on('addReaction', async (data, callback) => {
    try {
      const { messageId, emoji } = data;
      const user = socket.data.user;
      
      if (!user) {
        return callback?.({ message: 'You must be logged in to react to messages.' });
      }
      
      const message = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
      if (message.rows.length === 0) {
        return callback?.({ message: 'Message not found.' });
      }
      
      const existingReaction = await db.query(
        'SELECT * FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, user.id, emoji]
      );
      
      let reaction;
      
      if (existingReaction.rows.length > 0) {
        await db.query(
          'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
          [messageId, user.id, emoji]
        );
        
        reaction = {
          removed: true,
          messageId,
          emoji,
          username: user.username
        };
      } else {
        await db.query(
          'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
          [messageId, user.id, emoji]
        );
        
        reaction = {
          messageId,
          emoji,
          username: user.username
        };
      }
      
      io.emit('messageReaction', reaction);
      
      callback?.();
    } catch (error) {
      console.error('Error handling reaction:', error);
      callback?.({ message: 'Failed to add reaction.' });
    }
  });

  socket.on('typing', () => {
    const user = socket.data.user;
    if (!user) return;
    
    socket.broadcast.emit('userTyping', {
      id: user.id,
      username: user.username
    });
  });
  
  socket.on('stoppedTyping', () => {
    const user = socket.data.user;
    if (!user) return;
    
    socket.broadcast.emit('userStoppedTyping', {
      id: user.id,
      username: user.username
    });
  });

  socket.on('sendReplyMessage', async (messageData, callback) => {
    try {
      const user = socket.data.user;
      
      if (!user) {
        return callback?.({ message: 'You must be logged in to send messages.' });
      }
      
      if (!messageData.content || messageData.content.trim() === '') {
        return callback?.({ message: 'Message content is required.' });
      }
      
      if (!messageData.parentMessageId) {
        return callback?.({ message: 'Parent message ID is required for replies.' });
      }
      
      const parentMessage = await db.query('SELECT * FROM messages WHERE id = $1', [messageData.parentMessageId]);
      if (parentMessage.rows.length === 0) {
        return callback?.({ message: 'Parent message not found.' });
      }
      
      console.log(`User ${user.username} replying to message ${messageData.parentMessageId}: ${messageData.content}`);
      
      const newMessage = await db.query(
        'INSERT INTO messages (user_id, content, parent_message_id) VALUES ($1, $2, $3) RETURNING *',
        [user.id, messageData.content, messageData.parentMessageId]
      );
      
      const parentMessageInfo = await db.query(
        'SELECT m.id, m.content, m.type, m.user_id, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1',
        [messageData.parentMessageId]
      );
      
      const message = {
        ...newMessage.rows[0],
        username: user.username,
        reactions: [],
        parentMessage: parentMessageInfo.rows[0]
      };
      
      console.log('Reply message saved to database:', message.id);
      
      io.emit('newMessage', message);
      
      callback?.();
    } catch (error) {
      console.error('Error sending reply message:', error);
      callback?.({ message: 'Failed to send reply. Please try again.' });
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
    
    if (activeUsers.has(socket.id)) {
      const user = activeUsers.get(socket.id);
      activeUsers.delete(socket.id);
      
      io.emit('userLeft', {
        id: user.id,
        username: user.username,
        timestamp: new Date()
      });
      
      io.emit('activeUsers', Array.from(activeUsers.values()));
    }
  });

socket.on('sendAudioMessage', async (messageData, callback) => {
  try {
    const user = socket.data.user;
    
    if (!user) {
      return callback?.({ message: 'You must be logged in to send messages.' });
    }
    
    if (!messageData.audioUrl) {
      return callback?.({ message: 'Audio URL is required.' });
    }
    
    console.log(`User ${user.username} sending audio message: ${messageData.audioUrl}`);
    
    const newMessage = await db.query(
      'INSERT INTO messages (user_id, content, type, audio_url, audio_duration) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user.id, 'Audio message', 'audio', messageData.audioUrl, messageData.duration || 0]
    );
    
    const message = {
      ...newMessage.rows[0],
      username: user.username,
      reactions: []
    };
    
    console.log('Audio message saved to database:', message.id);
    
    io.emit('newMessage', message);
    
    callback?.();
  } catch (error) {
    console.error('Error sending audio message:', error);
    callback?.({ message: 'Failed to send audio message. Please try again.' });
  }
});

socket.on('sendFileMessage', async (messageData, callback) => {
  try {
    const user = socket.data.user;
    
    if (!user) {
      return callback?.({ message: 'You must be logged in to send files.' });
    }
    
    if (!messageData.fileUrl) {
      return callback?.({ message: 'File URL is required.' });
    }
    
    const newMessage = await db.query(
      `INSERT INTO messages 
        (user_id, content, type, file_url, file_name, file_type, file_size, is_image) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [
        user.id, 
        messageData.caption || 'File shared', 
        'file',
        messageData.fileUrl,
        messageData.fileName,
        messageData.fileType,
        messageData.fileSize,
        messageData.isImage
      ]
    );
    
    const message = {
      ...newMessage.rows[0],
      username: user.username,
      reactions: []
    };
    
    io.emit('newMessage', message);
    
    callback?.();
  } catch (error) {
    console.error('Error sending file message:', error);
    callback?.({ message: 'Failed to send file. Please try again.' });
  }
});
});

const PORT = process.env.PORT || 5000; 
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} ****** => CHAT SERVER => *******`);
});