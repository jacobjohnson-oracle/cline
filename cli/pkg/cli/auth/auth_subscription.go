package auth

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/cline/cli/pkg/cli/display"
	"github.com/cline/cli/pkg/cli/global"
	"github.com/cline/grpc-go/cline"
)

// AuthStatusListener manages subscription to auth status updates
type AuthStatusListener struct {
	stream    cline.AccountService_SubscribeToAuthStatusUpdateClient
	updatesCh chan *cline.AuthState
	errCh     chan error
	ctx       context.Context
	cancel    context.CancelFunc
}

// NewAuthStatusListener creates a new auth status listener
func NewAuthStatusListener(parentCtx context.Context) (*AuthStatusListener, error) {
	client, err := global.GetDefaultClient(parentCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get client: %w", err)
	}

	// Create cancellable context
	ctx, cancel := context.WithCancel(parentCtx)

	// Subscribe to auth status updates
	stream, err := client.Account.SubscribeToAuthStatusUpdate(ctx, &cline.EmptyRequest{})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to subscribe to auth updates: %w", err)
	}

	return &AuthStatusListener{
		stream:    stream,
		updatesCh: make(chan *cline.AuthState, 10),
		errCh:     make(chan error, 1),
		ctx:       ctx,
		cancel:    cancel,
	}, nil
}

// Start begins listening to the auth status update stream
func (l *AuthStatusListener) Start() error {
	verboseLog("Starting auth status listener...")

	go l.readStream()

	return nil
}

// readStream reads from the gRPC stream and forwards messages to channels
func (l *AuthStatusListener) readStream() {
	defer close(l.updatesCh)
	defer close(l.errCh)

	for {
		select {
		case <-l.ctx.Done():
			verboseLog("Auth listener context cancelled")
			return
		default:
			state, err := l.stream.Recv()
			if err != nil {
				if err == io.EOF {
					verboseLog("Auth status stream closed")
					return
				}
				verboseLog("Error reading from auth status stream: %v", err)
				select {
				case l.errCh <- err:
				case <-l.ctx.Done():
				}
				return
			}

			verboseLog("Received auth state update: user=%v", state.User != nil)

			select {
			case l.updatesCh <- state:
			case <-l.ctx.Done():
				return
			}
		}
	}
}

// WaitForAuthentication blocks until authentication succeeds or timeout occurs
func (l *AuthStatusListener) WaitForAuthentication(timeout time.Duration) error {
	verboseLog("Waiting for authentication (timeout: %v)...", timeout)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return fmt.Errorf("authentication timeout after %v - please try again", timeout)

		case <-l.ctx.Done():
			return fmt.Errorf("authentication cancelled")

		case err := <-l.errCh:
			return fmt.Errorf("authentication stream error: %w", err)

		case state := <-l.updatesCh:
			if isAuthenticated(state) {
				verboseLog("Authentication successful!")
				return nil
			}
			verboseLog("Received auth update but not authenticated yet...")
		}
	}
}

// Stop closes the stream and cleans up resources
func (l *AuthStatusListener) Stop() {
	verboseLog("Stopping auth status listener...")
	l.cancel()
}

// isAuthenticated checks if AuthState indicates successful authentication
func isAuthenticated(state *cline.AuthState) bool {
	return state != nil && state.User != nil
}

// Global OCA auth subscription singleton (CLI-only)
var (
	ocaAuthSubscriptionOnce sync.Once
	ocaAuthSubscriptionErr  error
)

// InitOcaAuthSubscriptions initializes long-lived OCA auth status subscriptions for the CLI
// This ensures Core-initiated re-auth (device code) is caught and rendered even outside wizard flows
func InitOcaAuthSubscriptions(ctx context.Context, sysRenderer *display.SystemMessageRenderer) error {
	var initErr error
	ocaAuthSubscriptionOnce.Do(func() {
		// Ensure the OCA auth listener exists and is subscribed
		listener, err := GetOcaAuthListener(ctx)
		if err != nil {
			initErr = fmt.Errorf("failed to initialize OCA auth listener: %w", err)
			return
		}

		// Start a goroutine to monitor for device auth and render it
		go func() {
			// Check for any cached device auth on startup
			if sysRenderer != nil {
				listener.PrintDeviceAuthIfPresent(0, sysRenderer)
			}

			// Monitor for new device auth events from the updates channel
			for {
				select {
				case <-ctx.Done():
					return
				case state, ok := <-listener.updatesCh:
					if !ok {
						// Channel closed
						return
					}
					// Check if this state has device auth
					if state.DeviceAuth != nil && sysRenderer != nil {
						_ = sysRenderer.RenderOcaDeviceAuth(state.DeviceAuth)
					}
				}
			}
		}()
	})

	if initErr != nil {
		ocaAuthSubscriptionErr = initErr
	}

	return ocaAuthSubscriptionErr
}
