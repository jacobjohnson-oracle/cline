package auth

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/cline/cli/pkg/cli/display"
	"github.com/cline/cli/pkg/cli/global"
	"github.com/cline/cli/pkg/cli/task"
	"github.com/cline/grpc-go/client"
	"github.com/cline/grpc-go/cline"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

var debugAuth = strings.ToLower(os.Getenv("CLINE_AUTH_DEBUG")) == "1"

func dbg(format string, a ...any) {
	if debugAuth {
		log.Printf("[OCA-CLI] "+format, a...)
	}
}

// OcaConfig holds Oracle Code Assist (OCA) configuration fields
type OcaConfig struct {
	BaseURL  string
	Mode     string
	OcaAuthMode cline.OcaAuthMode
}

// PromptForOcaConfig displays a form for OCA configuration (base URL, mode, and browser usage)
func PromptForOcaConfig(ctx context.Context, manager *task.Manager) (*OcaConfig, error) {
	config := &OcaConfig{}
	var mode string

	// Default to using the browser for authentication
	config.OcaAuthMode = cline.OcaAuthMode_BROWSER

	// Collect optional settings
	configForm := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Base URL").
				Value(&config.BaseURL).
				Description("Leave empty to use default Base URL"),

			huh.NewSelect[string]().
				Title("Choose OCA mode (used for authentication)").
				Description("Select 'Internal' to use Cline's internal OCA, or 'External' for your own OCA instance").
				Options(
					huh.NewOption("Internal", "internal"),
					huh.NewOption("External", "external"),
				).
				Value(&mode),

			huh.NewSelect[cline.OcaAuthMode]().
				Title("Choose authentication method").
				Description("Select how you want to authenticate with OCA").
				Options(
					huh.NewOption("Browser (opens automatically)", cline.OcaAuthMode_BROWSER),
					huh.NewOption("Device Code (display code to enter)", cline.OcaAuthMode_DEVICE_CODE),
				).
				Value(&config.OcaAuthMode),
		),
	)

	if err := configForm.Run(); err != nil {
		return nil, fmt.Errorf("failed to get OCA configuration: %w", err)
	}

	// Trim whitespace from string fields
	config.BaseURL = strings.TrimSpace(config.BaseURL)
	config.Mode = strings.TrimSpace(mode)

	return config, nil
}

// ApplyOcaConfig applies OCA configuration using partial updates
func ApplyOcaConfig(ctx context.Context, manager *task.Manager, config *OcaConfig) error {
	// Build the API configuration with all OCA fields
	apiConfig := &cline.ModelsApiConfiguration{}

	// Set profile authentication fields (always required)
	optionalFields := &OcaOptionalFields{}

	// Set profile name (can be empty for default profile)
	if config.BaseURL != "" {
		optionalFields.BaseURL = proto.String(config.BaseURL)
	}

	// Set optional fields if provided
	if config.Mode != "" {
		optionalFields.Mode = proto.String(config.Mode)
	}

	// Always set AuthMode
	optionalFields.AuthMode = &config.OcaAuthMode

	// Apply all fields to the config
	setOcaOptionalFields(apiConfig, optionalFields)

	// Add profile authentication field paths
	optionalPaths := buildOcaOptionalFieldMask(optionalFields)

	// Create field mask
	fieldMask := &fieldmaskpb.FieldMask{Paths: optionalPaths}

	// Apply the partial update
	request := &cline.UpdateApiConfigurationPartialRequest{
		ApiConfiguration: apiConfig,
		UpdateMask:       fieldMask,
	}

	if err := updateApiConfigurationPartial(ctx, manager, request); err != nil {
		return fmt.Errorf("failed to apply OCA configuration: %w", err)
	}

	return nil
}

// ===========================
// OCA Auth Listener Singleton
// ===========================

type ocaAuthStream interface {
	Recv() (*cline.OcaAuthState, error)
}

// OcaAuthStatusListener manages subscription to OCA auth status updates
type OcaAuthStatusListener struct {
	stream        ocaAuthStream
	updatesCh     chan *cline.OcaAuthState
	errCh         chan error
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.RWMutex
	lastState     *cline.OcaAuthState
	firstEventCh  chan struct{}
	firstEventOnce sync.Once
}

// NewOcaAuthStatusListener creates a new OCA auth status listener
func NewOcaAuthStatusListener(parentCtx context.Context) (*OcaAuthStatusListener, error) {
	client, err := global.GetDefaultClient(parentCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get client: %w", err)
	}

	// Keep the listener alive independently of short-lived caller contexts
	ctx, cancel := context.WithCancel(context.Background())

	// Subscribe to OCA auth status updates
	stream, err := client.Ocaaccount.OcaSubscribeToAuthStatusUpdate(ctx, &cline.EmptyRequest{})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to subscribe to OCA auth updates: %w", err)
	}

	return &OcaAuthStatusListener{
		stream:       stream,
		updatesCh:    make(chan *cline.OcaAuthState, 10),
		errCh:        make(chan error, 1),
		ctx:          ctx,
		cancel:       cancel,
		firstEventCh: make(chan struct{}),
	}, nil
}

// Start begins listening to the auth status update stream
func (l *OcaAuthStatusListener) Start() error {
	go l.readStream()
	return nil
}

func (l *OcaAuthStatusListener) readStream() {
	defer close(l.updatesCh)
	defer close(l.errCh)

	for {
		select {
		case <-l.ctx.Done():
			dbg("readStream: ctx done: %v", l.ctx.Err())
			return
		default:
			state, err := l.stream.Recv()
			if err != nil {
				// Propagate error and exit
				if err == io.EOF {
					// Treat as error to notify waiters
					err = fmt.Errorf("OCA auth status stream closed")
				}
				dbg("readStream: recv error: %v", err)
				select {
				case l.errCh <- err:
				case <-l.ctx.Done():
				}
				return
			}

			dbg("recv: user=%v deviceAuth=%v", state.User != nil, state.DeviceAuth != nil)
			if state.DeviceAuth != nil {
				da := state.DeviceAuth
				dbg("deviceAuth payload: uri=%q complete=%q code=%q expiresIn=%d interval=%d",
					da.VerificationUri, da.VerificationUriComplete, da.UserCode, da.ExpiresIn, da.Interval)
			}

			l.mu.Lock()
			l.lastState = state
			l.mu.Unlock()

			// Notify first event waiters
			l.firstEventOnce.Do(func() { close(l.firstEventCh) })

			dbg("enqueue to updatesCh")
			select {
			case l.updatesCh <- state:
			case <-l.ctx.Done():
				return
			}
		}
	}
}

// WaitForFirstEvent blocks until the first event is received or timeout occurs
func (l *OcaAuthStatusListener) WaitForFirstEvent(timeout time.Duration) error {
	// Fast-path if already have a state
	l.mu.RLock()
	ready := l.lastState != nil
	l.mu.RUnlock()
	if ready {
		return nil
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-l.firstEventCh:
		return nil
	case <-timer.C:
		return fmt.Errorf("timeout waiting for initial OCA auth event")
	case <-l.ctx.Done():
		return fmt.Errorf("OCA auth listener cancelled")
	}
}

// IsAuthenticated returns true if the last known OCA auth state is authenticated
func (l *OcaAuthStatusListener) IsAuthenticated() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return isOCAStateAuthenticated(l.lastState)
}

// WaitForDeviceAuthStart waits for device auth start details to be received
func (l *OcaAuthStatusListener) WaitForDeviceAuthStart(timeout time.Duration) (*cline.OcaDeviceAuthStartResponse, error) {
	dbg("WaitForDeviceAuthStart(timeout=%s)", timeout)
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	// Check if we already have device auth details
	l.mu.RLock()
	hasDeviceAuth := l.lastState != nil && l.lastState.DeviceAuth != nil
	dbg("lastState already had deviceAuth: %v", hasDeviceAuth)
	if hasDeviceAuth {
		response := l.lastState.DeviceAuth
		l.mu.RUnlock()
		return response, nil
	}
	l.mu.RUnlock()

	for {
		select {
		case <-timer.C:
			dbg("timer fired; no deviceAuth received")
			return nil, fmt.Errorf("timeout waiting for device auth start details")
		case <-l.ctx.Done():
			dbg("ctx done: %v", l.ctx.Err())
			return nil, fmt.Errorf("OCA auth listener cancelled")
		case err := <-l.errCh:
			dbg("errCh received: %v", err)
			return nil, fmt.Errorf("OCA authentication stream error: %w", err)
		case state := <-l.updatesCh:
			dbg("updatesCh recv; deviceAuth=%v", state.DeviceAuth != nil)
			if state.DeviceAuth != nil {
				return state.DeviceAuth, nil
			}
		}
	}
}

// WaitForAuthentication waits until OCA authentication succeeds or timeout occurs
func (l *OcaAuthStatusListener) WaitForAuthentication(timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	// If already authenticated, return immediately
	if l.IsAuthenticated() {
		return nil
	}

	for {
		select {
		case <-timer.C:
			return fmt.Errorf("OCA authentication timeout after %v - please try again", timeout)
		case <-l.ctx.Done():
			return fmt.Errorf("OCA authentication cancelled")
		case err := <-l.errCh:
			return fmt.Errorf("OCA authentication stream error: %w", err)
		case state := <-l.updatesCh:
			if isOCAStateAuthenticated(state) {
				return nil
			}
		}
	}
}

// Stop closes the stream and cleans up resources
func (l *OcaAuthStatusListener) Stop() {
	l.cancel()
}

// PrintDeviceAuthIfPresent prints device code details if present in latest state.
// If wait > 0, it will wait up to that duration for a DeviceAuth event on updatesCh.
// Returns true if device auth was printed, false otherwise.
func (l *OcaAuthStatusListener) PrintDeviceAuthIfPresent(wait time.Duration, sys *display.SystemMessageRenderer) bool {
	dbg("PrintDeviceAuthIfPresent(wait=%s)", wait)
	// 1) Try latest state
	l.mu.RLock()
	hasDeviceAuth := l.lastState != nil && l.lastState.DeviceAuth != nil
	dbg("lastState present=%v deviceAuth=%v", l.lastState != nil, hasDeviceAuth)
	if hasDeviceAuth {
		resp := l.lastState.DeviceAuth
		l.mu.RUnlock()
		if sys != nil {
			_ = sys.RenderOcaDeviceAuth(resp)
		} else {
			printDeviceAuth(resp)
		}
		dbg("printed device code from lastState")
		return true
	}
	l.mu.RUnlock()

	if wait <= 0 {
		dbg("no wait specified, returning false")
		return false
	}

	// 2) Give a small grace period to catch an in-flight event
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			dbg("timer fired; no deviceAuth received")
			return false
		case state := <-l.updatesCh:
			dbg("updatesCh received; deviceAuth=%v", state.DeviceAuth != nil)
			// Always keep lastState up to date for other listeners
			l.mu.Lock()
			l.lastState = state
			l.mu.Unlock()
			if state.DeviceAuth != nil {
				if sys != nil {
					dbg("printing using renderer")
					_ = sys.RenderOcaDeviceAuth(state.DeviceAuth)
				} else {
					dbg("printing using printf")
					printDeviceAuth(state.DeviceAuth)
				}
				dbg("printed device code from updatesCh")
				return true
			}
		case err := <-l.errCh:
			dbg("errCh received: %v", err)
			_ = err // ignore for this helper; caller handles errors elsewhere
			return false
		case <-l.ctx.Done():
			dbg("ctx done: %v", l.ctx.Err())
			return false
		}
	}
}

func printDeviceAuth(resp *cline.OcaDeviceAuthStartResponse) {
	fmt.Println("\nOCA device authentication required.")
	fmt.Printf("Visit: %s\n", resp.VerificationUri)
	fmt.Printf("Enter code: %s\n", resp.UserCode)
	fmt.Printf("Code expires in: %d seconds\n", resp.ExpiresIn)
	fmt.Println("Waiting for you to complete OCA authentication...")
}

func isOCAStateAuthenticated(state *cline.OcaAuthState) bool {
	return state != nil && state.User != nil
}

// Singleton holder
var (
	ocaListener     *OcaAuthStatusListener
	ocaListenerOnce sync.Once
	ocaListenerErr  error
)

// GetOcaAuthListener returns the OCA auth listener singleton
func GetOcaAuthListener(ctx context.Context) (*OcaAuthStatusListener, error) {
	// Allow optional ctx: if nil, use context.TODO(). If already initialized, return singleton.
	if ctx == nil {
		ctx = context.TODO()
	}

	ocaListenerOnce.Do(func() {
		l, err := NewOcaAuthStatusListener(ctx)
		if err != nil {
			ocaListenerErr = err
			return
		}
		if err := l.Start(); err != nil {
			ocaListenerErr = err
			return
		}
		ocaListener = l
	})
	return ocaListener, ocaListenerErr
}

// IsOCAAuthenticated returns true if the global OCA auth status is authenticated.
// It attempts a brief wait for the first event to avoid stale reads.
func IsOCAAuthenticated(ctx context.Context) bool {
	l, err := GetOcaAuthListener(ctx)
	if err != nil {
		return false
	}
	_ = l.WaitForFirstEvent(1 * time.Second) // best-effort
	return l.IsAuthenticated()
}

 // LatestState returns the last received OCA auth state (may be nil)
func (l *OcaAuthStatusListener) LatestState() *cline.OcaAuthState {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.lastState
}

// GetLatestOCAState returns the latest known OCA auth state, optionally waiting for the first event
func GetLatestOCAState(ctx context.Context, timeout time.Duration) (*cline.OcaAuthState, error) {
	l, err := GetOcaAuthListener(ctx)
	if err != nil {
		return nil, err
	}
	if timeout > 0 {
		if err := l.WaitForFirstEvent(timeout); err != nil {
			return nil, err
		}
	}
	return l.LatestState(), nil
}

// ensureOcaAuthenticated initiates OCA login (if needed) and waits for success using the singleton listener
func ensureOcaAuthenticated(ctx context.Context, authMode cline.OcaAuthMode, sys *display.SystemMessageRenderer) error {
	dbg("ensureOcaAuthenticated: mode=%v", authMode)
	// Ensure listener exists
	listener, err := GetOcaAuthListener(ctx)
	if err != nil {
		return fmt.Errorf("failed to initialize OCA auth listener: %w", err)
	}

	// Best-effort: if Core already pushed a device-code re-auth prompt, display it.
	// Use a short wait to catch in-flight events (e.g., 2 seconds).
	dbg("calling PrintDeviceAuthIfPresent preflight")
	dbg("sys is %w", sys)
	_ = listener.PrintDeviceAuthIfPresent(2 * time.Second, sys)

	// Briefly wait for first event to know current state
	dbg("calling WaitForFirstEvent")
	_ = listener.WaitForFirstEvent(1 * time.Second)

	dbg("IsAuthenticated=%v", listener.IsAuthenticated())
	// If already authenticated, nothing to do
	if listener.IsAuthenticated() {
		fmt.Println("✓ OCA authentication already active.")
		return nil
	}

	// Create gRPC client for initiating login
	client, err := global.GetDefaultClient(ctx)
	if err != nil {
		return fmt.Errorf("failed to obtain client: %w", err)
	}

	// Start login and wait for authentication
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	switch authMode {
		case cline.OcaAuthMode_DEVICE_CODE:
			return deviceCodeAuthentication(client, waitCtx, listener, sys)
		default:
			return browserAuthentication(client, waitCtx, listener)
	}
}

func browserAuthentication(client *client.ClineClient, waitCtx context.Context, listener* OcaAuthStatusListener) error {
	// Initiate login (opens the browser with a callback URL from Cline Core)
	response, err := client.Ocaaccount.OcaAccountLoginClicked(waitCtx, &cline.EmptyRequest{})
	if err != nil {
		return fmt.Errorf("failed to initiate OCA login: %w", err)
	}

	fmt.Println("\nOpening browser for OCA authentication...")
	if response != nil && response.Value != "" {
		fmt.Printf("If the browser doesn't open automatically, visit this URL:\n%s\n\n", response.Value)
	}
	fmt.Println("Waiting for you to complete OCA authentication in your browser...")
	fmt.Println("(This may take a few moments. Timeout: 5 minutes)")

	// Block until authenticated or timeout
	if err := listener.WaitForAuthentication(5 * time.Minute); err != nil {
		return err
	}
	return nil
}

func deviceCodeAuthentication(client *client.ClineClient, waitCtx context.Context, listener* OcaAuthStatusListener, sys *display.SystemMessageRenderer) error {
	// Use device code authentication - initiate the flow
	_, err := client.Ocaaccount.OcaStartDeviceAuth(waitCtx, &cline.EmptyRequest{})
	if err != nil {
		return fmt.Errorf("failed to initiate OCA device authentication: %w", err)
	}

	// Wait for device auth details to be sent over the stream
	response, err := listener.WaitForDeviceAuthStart(10 * time.Second)
	if err != nil {
		return fmt.Errorf("failed to receive device auth details: %w", err)
	}
	
	printDeviceAuth(response)

	// Block until authenticated or timeout
	if err := listener.WaitForAuthentication(time.Duration(response.ExpiresIn) * time.Second); err != nil {
		return err
	}
	return nil
}
