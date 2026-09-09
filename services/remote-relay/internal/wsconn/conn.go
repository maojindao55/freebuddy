package wsconn

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
)

var (
	ErrBackpressure = errors.New("send queue full: slow consumer disconnected")
	ErrClosed       = errors.New("connection closed")
)

// WSConn encapsulates a WebSocket connection with isolated reader/writer loops,
// bounded send queues, and graceful/backpressure closure semantics.
type WSConn struct {
	id         string
	role       string
	hostID     string
	adminID    string
	remoteAddr string

	ws            *websocket.Conn
	sendQueue     chan []byte
	maxFrameBytes int64
	writeTimeout  time.Duration
	logger        *slog.Logger

	ctx           context.Context
	cancel        context.CancelFunc
	closed        atomic.Bool
	closeOnce     sync.Once
	heartbeatOnce sync.Once
	writerDone    chan struct{}
}

// Config provides configuration parameters for a WSConn.
type Config struct {
	MaxFrameBytes    int64
	MaxSendQueueSize int
	WriteTimeout     time.Duration
	Logger           *slog.Logger
	RemoteAddr       string
}

// NewWSConn wraps an accepted websocket.Conn into a managed WSConn.
func NewWSConn(ws *websocket.Conn, cfg Config) *WSConn {
	if cfg.MaxFrameBytes <= 0 {
		cfg.MaxFrameBytes = protocol.MaxAllowedFrameBytes
	}
	if cfg.MaxSendQueueSize <= 0 {
		cfg.MaxSendQueueSize = 256
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 10 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	ctx, cancel := context.WithCancel(context.Background())

	connID := GenerateConnectionID()

	c := &WSConn{
		id:            connID,
		role:          "unauthenticated",
		remoteAddr:    cfg.RemoteAddr,
		ws:            ws,
		sendQueue:     make(chan []byte, cfg.MaxSendQueueSize),
		maxFrameBytes: cfg.MaxFrameBytes,
		writeTimeout:  cfg.WriteTimeout,
		logger:        cfg.Logger.With(slog.String("conn_id", connID)),
		ctx:           ctx,
		cancel:        cancel,
		writerDone:    make(chan struct{}),
	}

	if ws != nil {
		go c.writerLoop()
	} else {
		close(c.writerDone)
	}

	return c
}

// ID returns the unique connection ID.
func (c *WSConn) ID() string {
	return c.id
}

// Role returns the authenticated role ("host", "admin", or "unauthenticated").
func (c *WSConn) Role() string {
	return c.role
}

// SetRole sets the authenticated role on this connection.
func (c *WSConn) SetRole(role string) {
	c.role = role
}

// HostID returns the bound host ID if authenticated as host.
func (c *WSConn) HostID() string {
	return c.hostID
}

// SetHostID binds a hostId permanently to this connection upon authentication.
func (c *WSConn) SetHostID(hostID string) {
	c.hostID = hostID
}

// AdminID returns the admin session ID if authenticated as admin.
func (c *WSConn) AdminID() string {
	return c.adminID
}

// SetAdminID binds an admin ID to this connection.
func (c *WSConn) SetAdminID(adminID string) {
	c.adminID = adminID
}

// Context returns the connection lifetime context.
func (c *WSConn) Context() context.Context {
	return c.ctx
}

// SendEnvelope encodes and enqueues an envelope for sending.
// If the send queue is full, the slow consumer connection is immediately isolated and closed.
func (c *WSConn) SendEnvelope(env *protocol.Envelope) error {
	if c.closed.Load() {
		return ErrClosed
	}

	data, err := protocol.EncodeEnvelope(env)
	if err != nil {
		return fmt.Errorf("failed to encode envelope: %w", err)
	}

	select {
	case <-c.ctx.Done():
		return ErrClosed
	case c.sendQueue <- data:
		return nil
	default:
		// Send queue is full -> Slow consumer backpressure trigger
		c.logger.Warn("slow consumer detected: send queue full, closing connection with backpressure",
			slog.String("role", c.role),
			slog.String("host_id", c.hostID),
		)
		c.CloseWithBackpressure()
		return ErrBackpressure
	}
}

// SendEnvelopeSync directly writes an envelope synchronously to the websocket.
// This is used for handshake/auth responses or immediate error notifications before connection termination.
func (c *WSConn) SendEnvelopeSync(ctx context.Context, env *protocol.Envelope) error {
	if c.closed.Load() {
		return ErrClosed
	}

	data, err := protocol.EncodeEnvelope(env)
	if err != nil {
		return fmt.Errorf("failed to encode envelope: %w", err)
	}

	if c.ws == nil {
		return nil
	}

	return c.ws.Write(ctx, websocket.MessageText, data)
}

// SendRawBytes enqueues raw pre-encoded JSON frame bytes for sending.
func (c *WSConn) SendRawBytes(data []byte) error {
	if c.closed.Load() {
		return ErrClosed
	}

	select {
	case <-c.ctx.Done():
		return ErrClosed
	case c.sendQueue <- data:
		return nil
	default:
		c.CloseWithBackpressure()
		return ErrBackpressure
	}
}

// ReadEnvelope reads and strictly validates the next WebSocket text frame.
func (c *WSConn) ReadEnvelope(ctx context.Context) (*protocol.Envelope, error) {
	if c.closed.Load() {
		return nil, ErrClosed
	}

	msgType, reader, err := c.ws.Reader(ctx)
	if err != nil {
		return nil, err
	}

	if msgType != websocket.MessageText {
		return nil, errors.New("binary frames are not supported in remote protocol v1")
	}

	// Read up to maxFrameBytes + 1 to detect oversized frames
	limitReader := io.LimitReader(reader, c.maxFrameBytes+1)
	data, err := io.ReadAll(limitReader)
	if err != nil {
		return nil, fmt.Errorf("failed to read frame data: %w", err)
	}

	if int64(len(data)) > c.maxFrameBytes {
		return nil, fmt.Errorf("frame size exceeds limit of %d bytes", c.maxFrameBytes)
	}

	return protocol.DecodeEnvelope(data)
}

// writerLoop consumes the sendQueue and writes messages to the underlying WebSocket.
func (c *WSConn) writerLoop() {
	defer close(c.writerDone)

	for {
		select {
		case <-c.ctx.Done():
			return
		case data, ok := <-c.sendQueue:
			if !ok {
				return
			}

			writeCtx, writeCancel := context.WithTimeout(c.ctx, c.writeTimeout)
			err := c.ws.Write(writeCtx, websocket.MessageText, data)
			writeCancel()

			if err != nil {
				if !c.closed.Load() {
					c.logger.Debug("websocket write error", slog.String("error", err.Error()))
				}
				c.Close(websocket.StatusGoingAway, "write_error")
				return
			}
		}
	}
}

// Ping sends a native WebSocket ping frame.
func (c *WSConn) Ping(ctx context.Context) error {
	if c.ws == nil {
		return nil
	}
	return c.ws.Ping(ctx)
}

// StartHeartbeat starts an automatic periodic WebSocket ping/watchdog in the background.
// If a pong is not received within the timeout duration, the connection is closed with
// reason "heartbeat_timeout".
func (c *WSConn) StartHeartbeat(interval, timeout time.Duration) {
	if interval <= 0 || timeout <= 0 || c.ws == nil || c.closed.Load() {
		return
	}
	c.heartbeatOnce.Do(func() {
		go c.heartbeatLoop(interval, timeout)
	})
}

func (c *WSConn) heartbeatLoop(interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			if c.closed.Load() {
				return
			}

			pingCtx, pingCancel := context.WithTimeout(c.ctx, timeout)
			err := c.Ping(pingCtx)
			pingCancel()

			if err != nil {
				if !c.closed.Load() && !errors.Is(err, context.Canceled) && c.ctx.Err() == nil {
					c.logger.Warn("heartbeat ping failed or timed out",
						slog.String("role", c.role),
						slog.String("host_id", c.hostID),
						slog.String("error", err.Error()),
					)
					c.Close(websocket.StatusGoingAway, "heartbeat_timeout")
				}
				return
			}
		}
	}
}

// Close closes the connection gracefully with the specified status code and reason.
func (c *WSConn) Close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		c.cancel()

		// Attempt clean closure on the websocket connection
		if c.ws != nil {
			_ = c.ws.Close(code, reason)
		}
	})
}

// CloseWithBackpressure closes the connection when the send queue is full.
func (c *WSConn) CloseWithBackpressure() {
	c.Close(websocket.StatusPolicyViolation, "backpressure: send queue full")
}

// GenerateConnectionID generates a high-entropy connection ID (e.g. conn_...).
func GenerateConnectionID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return "conn_" + hex.EncodeToString(buf[:])
}
