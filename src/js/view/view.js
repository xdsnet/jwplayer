define([
    'utils/helpers',
    'events/events',
    'utils/backbone.events',
    'utils/constants',
    'utils/activeTab',
    'events/states',
    'view/captionsrenderer',
    'view/rewind-display-icon',
    'view/play-display-icon',
    'view/next-display-icon',
    'view/dock',
    'view/logo',
    'view/preview',
    'view/rightclick',
    'view/title',
    'view/components/nextuptooltip',
    'utils/underscore',
    'templates/player.html',
    'view/breakpoint',
    'view/components/button',
    'view/display-container',
], function(utils, events, Events, Constants, activeTab, states,
            CaptionsRenderer, RewindDisplayIcon, PlayDisplayIcon, NextDisplayIcon, Dock, Logo,
            Preview, RightClick, Title, NextUpToolTip, _, playerTemplate, setBreakpoint, button, DisplayContainer) {

    var _styles = utils.style;
    var _bounds = utils.bounds;
    var _isMobile = utils.isMobile();
    var DOCUMENT_FULLSCREEN_EVENTS = [
        'fullscreenchange',
        'webkitfullscreenchange',
        'mozfullscreenchange',
        'MSFullscreenChange'
    ];

    return function View(_api, _model) {
        var _playerElement;
        var _controls;
        var _controlsLayer;
        var CONTOLBAR_ONLY_HEIGHT = 44;
        var _videoLayer;
        var _lastWidth;
        var _lastHeight;
        var _instreamModel;
        var _preview;
        var _castDisplay;
        var _dock;
        var _logo;
        var _title;
        var _nextuptooltip;
        var _mute;
        var _captionsRenderer;
        var _rightClickMenu;
        var _resizeMediaTimeout = -1;
        var _resizeContainerRequestId = -1;
        var _requestFrame = window.requestAnimationFrame ||
            function (rafFunc) {
                return window.setTimeout(rafFunc, 17);
            };
        var _cancelDelayResize = window.cancelAnimationFrame || window.clearTimeout;
        var _previewDisplayStateTimeout = -1;
        var _currentState;
        var _originalContainer;
        var _requestFullscreen;
        var _exitFullscreen;
        var _elementSupportsFullscreen = false;
        var _focusFromClick = false;
        var _canvasColorContext;
        var _this = _.extend(this, Events);

        // Include the separate chunk that contains the @font-face definition.  Check webpackJsonjwplayer so we don't
        // run this in phantomjs because it breaks despite it working in browser and including files like we want it to.
        if (window.webpackJsonpjwplayer) {
            require('css/jwplayer.less');
        }

        this.model = _model;
        this.api = _api;

        _playerElement = utils.createElement(playerTemplate({ id: _model.get('id') }));
        if (utils.isIE()) {
            utils.addClass(_playerElement, 'jw-ie');
        }

        var width = _model.get('width');
        var height = _model.get('height');

        _styles(_playerElement, {
            width: width.toString().indexOf('%') > 0 ? width : (width + 'px'),
            height: height.toString().indexOf('%') > 0 ? height : (height + 'px')
        });

        _requestFullscreen =
            _playerElement.requestFullscreen ||
            _playerElement.webkitRequestFullscreen ||
            _playerElement.webkitRequestFullScreen ||
            _playerElement.mozRequestFullScreen ||
            _playerElement.msRequestFullscreen;
        _exitFullscreen =
            document.exitFullscreen ||
            document.webkitExitFullscreen ||
            document.webkitCancelFullScreen ||
            document.mozCancelFullScreen ||
            document.msExitFullscreen;
        _elementSupportsFullscreen = _requestFullscreen && _exitFullscreen;

        function reasonInteraction() {
            return { reason: 'interaction' };
        }

        function adjustSeek(amount) {
            var min = 0;
            var max = _model.get('duration');
            var position = _model.get('position');
            if (_model.get('streamType') === 'DVR') {
                min = max;
                max = Math.max(position, Constants.dvrSeekLimit);
            }
            var newSeek = utils.between(position + amount, min, max);
            _api.seek(newSeek, reasonInteraction());
        }

        function adjustVolume(amount) {
            var newVol = utils.between(_model.get('volume') + amount, 0, 100);
            _api.setVolume(newVol);
        }

        function allowKeyHandling(evt) {
            // If Meta keys return
            if (evt.ctrlKey || evt.metaKey) {
                return false;
            }

            // Controls may be disabled during share screens, or via API
            if (!_model.get('controls')) {
                return false;
            }
            return true;
        }

        function handleKeydown(evt) {
            if (!allowKeyHandling(evt)) {
                // Let event bubble upwards
                return true;
            }

            // On keypress show the controlbar for a few seconds
            if (!_instreamModel) {
                _controls.userActivity();
            }

            switch (evt.keyCode) {
                case 27: // Esc
                    _api.setFullscreen(false);
                    break;
                case 13: // enter
                case 32: // space
                    _api.play(reasonInteraction());
                    break;
                case 37: // left-arrow, if not adMode
                    if (!_instreamModel) {
                        adjustSeek(-5);
                    }
                    break;
                case 39: // right-arrow, if not adMode
                    if (!_instreamModel) {
                        adjustSeek(5);
                    }
                    break;
                case 38: // up-arrow
                    adjustVolume(10);
                    break;
                case 40: // down-arrow
                    adjustVolume(-10);
                    break;
                case 67: // c-key
                    var captionsList = _api.getCaptionsList();
                    var listLength = captionsList.length;
                    if (listLength) {
                        var nextIndex = (_api.getCurrentCaptions() + 1) % listLength;
                        _api.setCurrentCaptions(nextIndex);
                    }
                    break;
                case 77: // m-key
                    _api.setMute();
                    break;
                case 70: // f-key
                    _api.setFullscreen();
                    break;
                default:
                    if (evt.keyCode >= 48 && evt.keyCode <= 59) {
                        // if 0-9 number key, move to n/10 of the percentage of the video
                        var number = evt.keyCode - 48;
                        var newSeek = (number / 10) * _model.get('duration');
                        _api.seek(newSeek, reasonInteraction());
                    }
                    break;
            }

            if (/13|32|37|38|39|40/.test(evt.keyCode)) {
                // Prevent keypresses from scrolling the screen
                evt.preventDefault();
                return false;
            }
        }

        function handleBlur() {
            _focusFromClick = false;
            utils.removeClass(_playerElement, 'jw-no-focus');
        }

        function handleMouseUp(e) {
            if (e.target && e.target.blur) {
                e.target.blur();
            }
        }

        function handleMouseDown() {
            _focusFromClick = true;
            utils.addClass(_playerElement, 'jw-no-focus');
        }

        function handleFocus() {
            if (!_focusFromClick) {
                handleBlur();
            }

            // On tab-focus, show the control bar for a few seconds
            if (!_instreamModel && !_isMobile) {
                _controls.userActivity();
            }
        }

        function _setContainerDimensions() {
            var inDOM = document.body.contains(_playerElement);
            var bounds = _bounds(_playerElement);
            var containerWidth = Math.round(bounds.width);
            var containerHeight = Math.round(bounds.height);

            _cancelDelayResize(_resizeContainerRequestId);

            // If the container is the same size as before, return early
            if (containerWidth === _lastWidth && containerHeight === _lastHeight) {
                // Listen for player to be added to DOM
                if (!_lastWidth || !_lastHeight) {
                    _responsiveListener();
                }
                return;
            }
            // If we have bad values for either dimension, return early
            if (!containerWidth || !containerHeight) {
                // If we haven't established player size, try again
                if (!_lastWidth || !_lastHeight) {
                    _responsiveListener();
                }
                _model.set('inDom', inDOM);
                // Fire resize 0,0 if the player element is not in the DOM
                // This allows setup to complete even if element was removed from DOM
                if (!inDOM) {
                    _resized(containerWidth, containerHeight);
                }
                return;
            }

            _model.set('containerWidth', containerWidth);
            _model.set('containerHeight', containerHeight);
            _model.set('inDom', inDOM);

            var breakPoint = setBreakpoint(_playerElement, containerWidth, containerHeight);
            var controls = _model.get('controls');
            _checkAudioMode(_model.get('height'));
            _setTimesliderFlags(breakPoint, _model.get('audioMode'), controls);
            _onChangeControls(_model, controls);

            _resizeMedia(containerWidth, containerHeight);

            _captionsRenderer.resize();

            _resized(containerWidth, containerHeight);
        }

        function _resized(containerWidth, containerHeight) {
            _lastWidth = containerWidth;
            _lastHeight = containerHeight;
            _this.trigger(events.JWPLAYER_RESIZE, {
                width: containerWidth,
                height: containerHeight
            });
        }

        function _setTimesliderFlags(breakPoint, audioMode, controls) {
            var smallPlayer = breakPoint < 2;
            var timeSliderAboveConfig = _model.get('timeSliderAbove');
            var timeSliderAbove = !audioMode && controls &&
                (timeSliderAboveConfig !== false) && (timeSliderAboveConfig || smallPlayer);
            utils.toggleClass(_playerElement, 'jw-flag-small-player', smallPlayer);
            utils.toggleClass(_playerElement, 'jw-flag-audio-player', audioMode);
            utils.toggleClass(_playerElement, 'jw-flag-time-slider-above', timeSliderAbove);
        }

        function _responsiveListener() {
            _cancelDelayResize(_resizeContainerRequestId);
            _resizeContainerRequestId = _requestFrame(_setContainerDimensions);
        }

        // Set global colors, used by related plugin
        // If a color is undefined simple-style-loader won't add their styles to the dom
        function insertGlobalColorClasses(activeColor, inactiveColor, playerId) {
            if (activeColor) {
                var activeColorSet = {
                    color: activeColor,
                    borderColor: activeColor,
                    stroke: activeColor
                };
                utils.css('#' + playerId + ' .jw-color-active', activeColorSet, playerId);
                utils.css('#' + playerId + ' .jw-color-active-hover:hover', activeColorSet, playerId);
            }
            if (inactiveColor) {
                var inactiveColorSet = {
                    color: inactiveColor,
                    borderColor: inactiveColor,
                    stroke: inactiveColor
                };
                utils.css('#' + playerId + ' .jw-color-inactive', inactiveColorSet, playerId);
                utils.css('#' + playerId + ' .jw-color-inactive-hover:hover', inactiveColorSet, playerId);
            }
        }


        this.onChangeSkin = function (model, newSkin) {
            utils.replaceClass(_playerElement, /jw-skin-\S+/, newSkin ? ('jw-skin-' + newSkin) : '');
        };


        this.handleColorOverrides = function () {
            var id = _model.get('id');

            function getRgba(color, opacity) {
                var data;

                if (!_canvasColorContext) {
                    var canvas = document.createElement('canvas');

                    canvas.height = 1;
                    canvas.width = 1;

                    _canvasColorContext = canvas.getContext('2d');
                }

                _canvasColorContext.clearRect(0, 0, 1, 1);
                _canvasColorContext.fillStyle = color;
                _canvasColorContext.fillRect(0, 0, 1, 1);

                data = _canvasColorContext.getImageData(0, 0, 1, 1).data;

                return 'rgba(' + data[0] + ', ' + data[1] + ', ' + data[2] + ', ' + opacity + ')';
            }

            function addStyle(elements, attr, value, extendParent) {
                /* if extendParent is true, bundle the first selector of
                 element string to the player element instead of defining it as a
                 child of the player element (default). i.e. #player.sel-1 .sel-2 vs. #player .sel-1 .sel-2 */
                elements = utils.prefix(elements, '#' + id + (extendParent ? '' : ' '));

                var o = {};
                o[attr] = value;
                utils.css(elements.join(', '), o, id);
            }

            // We can assume that the user will define both an active and inactive color because otherwise it doesn't look good
            var activeColor = _model.get('skinColorActive');
            var inactiveColor = _model.get('skinColorInactive');
            var backgroundColor = _model.get('skinColorBackground');

            // These will use standard style names for CSS since they are added directly to a style sheet
            // Using background instead of background-color so we don't have to clear gradients with background-image
            if (activeColor) {
                // Apply active color
                addStyle([
                    // Toggle and menu button active colors
                    '.jw-button-color.jw-toggle',
                    '.jw-button-color:hover',
                    '.jw-button-color.jw-toggle.jw-off:hover',
                    '.jw-option:not(.jw-active-option):hover',
                    '.jw-nextup-header'
                ], 'color', activeColor);
                addStyle([
                    // menu active option
                    '.jw-option.jw-active-option',
                    // slider fill color
                    '.jw-progress'
                ], 'background', 'none ' + activeColor);
            }

            if (inactiveColor) {
                // Apply inactive color
                addStyle([
                    // text color of many ui elements
                    '.jw-text',
                    // menu option text
                    '.jw-option',
                    // controlbar button colors
                    '.jw-button-color',
                    // toggle button
                    '.jw-toggle.jw-off',
                    '.jw-skip .jw-skip-icon',
                    '.jw-nextup-body'
                ], 'color', inactiveColor);
                addStyle([
                    // slider children
                    '.jw-cue',
                    '.jw-knob',
                    '.jw-active-option',
                    '.jw-nextup-header'
                ], 'background', 'none ' + inactiveColor);
            }

            if (backgroundColor) {
                // Apply background color
                addStyle([
                    // general background color
                    '.jw-background-color'
                ], 'background', 'none ' + backgroundColor);

                if (_model.get('timeSliderAbove') !== false) {
                    var backgroundColorGradient = 'transparent linear-gradient(180deg, ' +
                        getRgba(backgroundColor, 0) + ' 0%, ' +
                        getRgba(backgroundColor, 0.25) + ' 30%, ' +
                        getRgba(backgroundColor, 0.4) + ' 70%, ' +
                        getRgba(backgroundColor, 0.5) + ') 100%';

                    addStyle([
                        // for small player, set the control bar gradient to the config background color
                        '.jw-flag-time-slider-above .jw-background-color.jw-controlbar'
                    ], 'background', backgroundColorGradient, true);
                }

                // remove the config background on time slider
                addStyle([
                    '.jw-flag-time-slider-above .jw-background-color.jw-slider-time'
                ], 'background', 'transparent', true);
            }

            insertGlobalColorClasses(activeColor, inactiveColor, id);
        };

        this.setup = function () {

            this.handleColorOverrides();

            // Hide control elements until skin is loaded
            if (_model.get('skin-loading') === true) {
                utils.addClass(_playerElement, 'jw-flag-skin-loading');
                _model.once('change:skin-loading', function () {
                    utils.removeClass(_playerElement, 'jw-flag-skin-loading');
                });
            }

            _model.change('skin', this.onChangeSkin, this);

            _videoLayer = _playerElement.querySelector('.jw-media');

            var previewElem = _playerElement.querySelector('.jw-preview');
            _preview = new Preview(_model);
            _preview.setup(previewElem);

            var _titleElement = _playerElement.querySelector('.jw-title');
            _title = new Title(_model);
            _title.setup(_titleElement);

            // captions rendering
            _captionsRenderer = new CaptionsRenderer(_model);
            _captionsRenderer.setup(_playerElement.id, _model.get('captions'));

            // captions should be place behind controls, and not hidden when controls are hidden
            _playerElement.insertBefore(_captionsRenderer.element(), _title.element());

            // adds video tag to video layer
            _model.set('mediaContainer', _videoLayer);

            // Native fullscreen (coming through from the provider)
            _model.mediaController.on('fullscreenchange', _fullscreenChangeHandler);
            // DOM fullscreen
            for (var i = DOCUMENT_FULLSCREEN_EVENTS.length; i--;) {
                document.addEventListener(DOCUMENT_FULLSCREEN_EVENTS[i], _fullscreenChangeHandler, false);
            }

            window.removeEventListener('resize', _responsiveListener);
            window.addEventListener('resize', _responsiveListener, false);
            if (_isMobile) {
                window.removeEventListener('orientationchange', _responsiveListener);
                window.addEventListener('orientationchange', _responsiveListener, false);
            }

            _model.change('controls', _onChangeControls);

            _model.change('flashBlocked', _onChangeFlashBlocked);

            _api.onPlaylistComplete(_playlistCompleteHandler);
            _api.onPlaylistItem(_playlistItemHandler);

            // set initial state
            if (_model.get('stretching')) {
                _onStretchChange(_model, _model.get('stretching'));
            }
            // watch for changes
            _model.on('change:state', _stateHandler);
            _model.on('change:stretching', _onStretchChange);
            _model.on('change:fullscreen', _fullscreen);
            _model.on('change:errorEvent', _errorHandler);
            _model.on('change:hideAdsControls', function (model, val) {
                utils.toggleClass(_playerElement, 'jw-flag-ads-hide-controls', val);
            });

            var aspectratio = _model.get('aspectratio');
            if (aspectratio) {
                _setAspectMode(aspectratio);
            }

            _model.set('iFrame', utils.isIframe());
            _model.set('activeTab', activeTab());
            document.addEventListener('visibilitychange', _visibilityChangeListener, false);
            document.addEventListener('webkitvisibilitychange', _visibilityChangeListener, false);

            _model.set('viewSetup', true);
            _model.set('inDom', document.body.contains(_playerElement));
        };

        this.init = function() {
            _resize(_model.get('width'), _model.get('height'));
            _stateHandler(_instreamModel || _model);
            _lastWidth = _lastHeight = null;
            _setContainerDimensions();
        };

        function _onStretchChange(model, newVal) {
            utils.replaceClass(_playerElement, /jw-stretch-\S+/, 'jw-stretch-' + newVal);
        }

        function _componentFadeListeners(comp) {
            if (comp && !_isMobile) {
                comp.element().addEventListener('mousemove', _overControlElement, false);
                comp.element().addEventListener('mouseout', _offControlElement, false);
            }
        }

        function _logoClickHandler(evt) {
            if (!evt.link) {
                // _togglePlay();
                if (_model.get('controls')) {
                    _api.play(reasonInteraction());
                }
            } else {
                _api.pause(true, reasonInteraction());
                _api.setFullscreen(false);
                window.open(evt.link, evt.linktarget);
            }
        }

        function _overControlElement() {
            // Over controlbar, timeout resumed when off controlbar
            clearTimeout(_controls.activeTimeout);
        }

        function _offControlElement() {
            _controls.userActivity();
        }

        function forward(evt) {
            _this.trigger(evt.type, evt);
        }

        function _onChangeFlashBlocked(model, isBlocked) {
            if (isBlocked) {
                if (_rightClickMenu) {
                    _rightClickMenu.destroy();
                }
                utils.addClass(_playerElement, 'jw-flag-flash-blocked');
            } else {
                if (_rightClickMenu) {
                    _rightClickMenu.setup(_model, _playerElement, _playerElement);
                }
                utils.removeClass(_playerElement, 'jw-flag-flash-blocked');
            }
        }

        var _onChangeControls = function (model, bool) {
            if (bool) {
                // ignore model that triggered this event and use current state model
                _stateHandler(_instreamModel || _model);
                _userActivity();
            }

            utils.toggleClass(_playerElement, 'jw-flag-controls-disabled', !bool);
        };

        this.addControls = function (controls) {
            _controls = controls;
            _setupControls();
            controls.enable(_api, _model, _videoLayer);

            // These need to be called after controls.enable:

            // Ignore iOS9. Muted autoplay is supported in iOS 10+
            if (_model.autoStartOnMobile()) {
                _mute = button('jw-autostart-mute jw-off', _autoplayUnmute, _model.get('localization').volume);
                _mute.show();
                _controlsLayer.appendChild(_mute.element());
                // Set mute state in the controlbar
                _controls.controlbar.renderVolume(true, _model.get('volume'));
                // Hide the controlbar until the autostart flag is removed
                utils.addClass(_playerElement, 'jw-flag-autostart');
                _model.set('autostartMuted', true);
                _model.on('change:autostartFailed', _autoplayUnmute);
                _model.on('change:autostartMuted', _autoplayUnmute);
                _model.on('change:mute', _autoplayUnmute);
            }
            if (_model.get('nextUpDisplay')) {
                _nextuptooltip = new NextUpToolTip(_model, _api, _playerElement);
                _nextuptooltip.setup();

                // NextUp needs to be behind the controlbar to not block other tooltips
                _controlsLayer.appendChild(_nextuptooltip.element());
            }

            _model.on('change:scrubbing', _dragging);
            _componentFadeListeners(_controls.controlbar);
            _controlsLayer.appendChild(_controls.controlbar.element());

            _playerElement.addEventListener('focus', handleFocus);
            _playerElement.addEventListener('blur', handleBlur);
            _playerElement.addEventListener('keydown', handleKeydown);
            _playerElement.onmousedown = handleMouseDown;
            _playerElement.onmouseup = handleMouseUp;

            _model.change('duration', _setLiveMode, this);
        };

        function _setupControls() {
            var overlaysElement = _playerElement.querySelector('.jw-overlays');
            overlaysElement.addEventListener('mousemove', _userActivityCallback);

            _controls.on('change:showing', function(/* showing */) {
                _captionsRenderer.renderCues(true);
            });

            _controlsLayer = _controls.getElement();
            _controlsLayer.appendChild(createDisplayContainer());

            _dock = new Dock(_model);

            _logo = new Logo(_model);

            var rightside = document.createElement('div');
            rightside.className = 'jw-controls-right jw-reset';
            rightside.appendChild(_dock.element());
            _logo.setup(rightside);
            _controlsLayer.appendChild(rightside);

            _logo.on(events.JWPLAYER_LOGO_CLICK, _logoClickHandler);
            _componentFadeListeners(_logo);

            // Touch UI mode when we're on mobile and we have a percentage height or we can fit the large UI in
            height = _model.get('height');
            if (_isMobile && (typeof height === 'string' || height >= CONTOLBAR_ONLY_HEIGHT)) {
                utils.addClass(_playerElement, 'jw-flag-touch');
            } else {
                _rightClickMenu = new RightClick();
                _rightClickMenu.setup(_model, _playerElement, _playerElement);
            }
        }

        this.removeControls = function () {
            if (_controls) {
                _controls.disable();
            }
            _destroyControls();
        };

        var _destroyControls = function () {
            var overlay = document.querySelector('.jw-overlays');
            if (overlay) {
                overlay.removeEventListener('mousemove', _userActivityCallback);
            }

            if (_dock) {
                _dock = null;
            }

            if (_logo) {
                _logo.destroy();
                _logo = null;
            }

            if (_rightClickMenu) {
                _rightClickMenu.destroy();
            }

            _playerElement.removeEventListener('focus', handleFocus);
            _playerElement.removeEventListener('blur', handleBlur);
            _playerElement.removeEventListener('keydown', handleKeydown);
            _playerElement.onmousedown = null;
            _playerElement.onmouseup = null;

            utils.removeClass(_playerElement, 'jw-flag-touch');
            utils.clearCss(_model.get('id'));

            clearTimeout(_previewDisplayStateTimeout);
            clearTimeout(_resizeMediaTimeout);
        };

        // Perform the switch to fullscreen
        var _fullscreen = function (model, state) {

            // If it supports DOM fullscreen
            var provider = _model.getVideo();

            // Unmute the video so volume can be adjusted with native controls in fullscreen
            if (state && _model.get('autostartMuted')) {
                _autoplayUnmute();
            }

            if (_elementSupportsFullscreen) {
                if (state) {
                    _requestFullscreen.apply(_playerElement);
                } else {
                    _exitFullscreen.apply(document);
                }
                _toggleDOMFullscreen(_playerElement, state);
            } else if (utils.isIE()) {
                _toggleDOMFullscreen(_playerElement, state);
            } else {
                // else use native fullscreen
                if (_instreamModel && _instreamModel.getVideo()) {
                    _instreamModel.getVideo().setFullscreen(state);
                }
                provider.setFullscreen(state);
            }
            // pass fullscreen state to Flash provider
            // provider.getName() is the same as _api.getProvider() or _model.get('provider')
            if (provider && provider.getName().name.indexOf('flash') === 0) {
                provider.setFullscreen(state);
            }
        };

        function _resize(playerWidth, playerHeight, resetAspectMode) {
            var playerStyle = {
                width: playerWidth
            };

            // when jwResize is called remove aspectMode and force layout
            resetAspectMode = !!resetAspectMode;
            if (resetAspectMode) {
                _model.set('aspectratio', null);
                _setAspectMode(null);
                playerStyle.display = 'block';
            }

            if (utils.exists(playerWidth) && utils.exists(playerHeight)) {
                _model.set('width', playerWidth);
                _model.set('height', playerHeight);
            }

            if (!_model.get('aspectratio')) {
                playerStyle.height = playerHeight;
            }

            _styles(_playerElement, playerStyle);

            _checkAudioMode(playerHeight);

            // pass width, height from jwResize if present
            _resizeMedia(playerWidth, playerHeight);
        }

        function _setAspectMode(aspectratio) {
            utils.toggleClass(_playerElement, 'jw-flag-aspect-mode', !!aspectratio);
            var aspectRatioContainer = _playerElement.querySelector('.jw-aspect');
            _styles(aspectRatioContainer, {
                paddingTop: aspectratio || null
            });
        }


        function _checkAudioMode(playerHeight) {
            var audioMode = _isAudioMode(playerHeight);
            if (_controls) {
                if (!audioMode) {
                    _stateHandler(_instreamModel || _model);
                }
            }
            _model.set('audioMode', audioMode);
        }

        function _isAudioMode(playerHeight) {
            if (_model.get('aspectratio')) {
                return false;
            }
            if (_.isString(playerHeight) && playerHeight.indexOf('%') > -1) {
                return false;
            }

            // Coerce into Number (don't parse out CSS units)
            var checkHeight = (playerHeight * 1) || null;
            checkHeight = (_.isNumber(checkHeight) ? checkHeight : _model.get('containerHeight'));
            if (!checkHeight) {
                return false;
            }

            return _isControlBarOnly(checkHeight);
        }

        function _isControlBarOnly(verticalPixels) {
            // 1.75 so there's a little wiggle room on mobile for the large UI to fit in
            return verticalPixels && verticalPixels <= CONTOLBAR_ONLY_HEIGHT;
        }

        function _resizeMedia(mediaWidth, mediaHeight) {
            if (!mediaWidth || isNaN(1 * mediaWidth)) {
                if (!_videoLayer) {
                    return;
                }
                mediaWidth = _lastWidth || _videoLayer.clientWidth;
            }
            if (!mediaHeight || isNaN(1 * mediaHeight)) {
                if (!_videoLayer) {
                    return;
                }
                mediaHeight = _lastHeight || _videoLayer.clientHeight;
            }

            if (_preview) {
                _preview.resize(mediaWidth, mediaHeight, _model.get('stretching'));
            }

            var provider = _model.getVideo();
            if (!provider) {
                return;
            }
            var transformScale = provider.resize(mediaWidth, mediaHeight, _model.get('stretching'));

            // poll resizing if video is transformed
            if (transformScale) {
                clearTimeout(_resizeMediaTimeout);
                _resizeMediaTimeout = setTimeout(_resizeMedia, 250);
            }
        }

        function _autoplayUnmute() {
            var autostartSucceeded = !_model.get('autostartFailed');
            var mute = _model.get('mute');

            // If autostart succeeded, it means the user has chosen to unmute the video,
            // so we should update the model, setting mute to false
            if (autostartSucceeded) {
                mute = false;
            } else {
                // Don't try to play again when viewable since it will keep failing
                _model.set('playOnViewable', false);
            }

            _model.off('change:autostartFailed', _autoplayUnmute);
            _model.off('change:mute', _autoplayUnmute);
            _model.off('change:autostartMuted', _autoplayUnmute);
            _model.set('autostartFailed', undefined);
            _model.set('autostartMuted', undefined);
            _api.setMute(mute);
            // the model's mute value may not have changed. ensure the controlbar's mute button is in the right state
            _controls.controlbar.renderVolume(mute, _model.get('volume'));
            _mute.hide();
            utils.removeClass(_playerElement, 'jw-flag-autostart');
        }

        this.resize = function (playerWidth, playerHeight) {
            var resetAspectMode = true;
            _resize(playerWidth, playerHeight, resetAspectMode);
            _setContainerDimensions();
        };
        this.resizeMedia = _resizeMedia;

        this.reset = function () {
            if (document.contains(_playerElement)) {
                _playerElement.parentNode.replaceChild(_originalContainer, _playerElement);
            }
            utils.emptyElement(_playerElement);
        };

        /**
         * Return whether or not we're in native fullscreen
         */
        function _isNativeFullscreen() {
            if (_elementSupportsFullscreen) {
                var fsElement = document.fullscreenElement ||
                    document.webkitCurrentFullScreenElement ||
                    document.mozFullScreenElement ||
                    document.msFullscreenElement;
                return !!(fsElement && fsElement.id === _model.get('id'));
            }
            // if player element view fullscreen not available, return video fullscreen state
            return _instreamModel ? _instreamModel.getVideo().getFullScreen() :
                _model.getVideo().getFullScreen();
        }


        function _fullscreenChangeHandler(event) {
            var modelState = _model.get('fullscreen');
            var newState = (event.jwstate !== undefined) ? event.jwstate : _isNativeFullscreen();

            // If fullscreen was triggered by something other than the player
            //  then we want to sync up our internal state
            if (modelState !== newState) {
                _model.set('fullscreen', newState);
            }

            _responsiveListener();
            clearTimeout(_resizeMediaTimeout);
            _resizeMediaTimeout = setTimeout(_resizeMedia, 200);
        }

        function _toggleDOMFullscreen(playerElement, fullscreenState) {
            if (fullscreenState) {
                utils.addClass(playerElement, 'jw-flag-fullscreen');
                _styles(document.body, {
                    'overflow-y': 'hidden'
                });

                // On going fullscreen we want the control bar to fade after a few seconds
                _controls.userActivity();
            } else {
                utils.removeClass(playerElement, 'jw-flag-fullscreen');
                _styles(document.body, {
                    'overflow-y': ''
                });
            }

            _resizeMedia();
            _responsiveListener();
        }

        function _userActivityCallback(/* event */) {
            _controls.userActivity();
        }

        function _playlistCompleteHandler() {
            _api.setFullscreen(false);
        }

        function _playlistItemHandler() {
            // update display title
            if (_castDisplay) {
                _castDisplay.setState(_model.get('state'));
            }
            _onMediaTypeChange(_model, _model.mediaModel.get('mediaType'));
            _model.mediaModel.on('change:mediaType', _onMediaTypeChange, this);
        }

        function _onMediaTypeChange(model, val) {
            var isAudioFile = (val === 'audio');
            var provider = _model.getVideo();
            var isFlash = (provider && provider.getName().name.indexOf('flash') === 0);

            utils.toggleClass(_playerElement, 'jw-flag-media-audio', isAudioFile);

            if (isAudioFile && !isFlash) {
                // Put the preview element before the media element in order to display browser captions
                _playerElement.insertBefore(_preview.el, _videoLayer);
            } else {
                // Put the preview element before the captions element to display captions with the captions renderer
                _playerElement.insertBefore(_preview.el, _captionsRenderer.element());
            }
        }

        function _setLiveMode(model, duration) {
            var minDvrWindow = model.get('minDvrWindow');
            var streamType = utils.streamType(duration, minDvrWindow);
            var live = (streamType === 'LIVE');

            model.set('streamType', streamType);
            utils.toggleClass(_playerElement, 'jw-flag-live', live);
            _this.setAltText((live) ? model.get('localization').liveBroadcast : '');
        }

        function _errorHandler(model, evt) {
            if (!evt) {
                _title.playlistItem(model, model.get('playlistItem'));
                return;
            }
            if (evt.name) {
                _title.updateText(evt.name, evt.message);
            } else {
                _title.updateText(evt.message, '');
            }
        }

        function _updateStateClass() {
            utils.replaceClass(_playerElement, /jw-state-\S+/, 'jw-state-' + _currentState);
        }

        function _stateHandler(model) {
            if (!_model.get('viewSetup')) {
                return;
            }

            _currentState = model.get('state');

            var instreamState = null;
            if (_instreamModel) {
                instreamState = _currentState;
            }
            if (_controls) {
                _controls.instreamState = instreamState;
            }

            // Throttle all state change UI updates except for play to prevent iOS 10 animation bug
            _cancelDelayResize(_previewDisplayStateTimeout);

            if (_currentState === states.PLAYING) {
                _stateUpdate(model, _currentState);
            } else {
                _previewDisplayStateTimeout = _requestFrame(function () {
                    _stateUpdate(model, _currentState);
                });
            }
            if (_currentState !== states.PAUSED && utils.hasClass(_playerElement, 'jw-flag-controls-hidden')) {
                utils.removeClass(_playerElement, 'jw-flag-controls-hidden');
            }
        }

        function _stateUpdate(model, state) {
            utils.toggleClass(_playerElement, 'jw-flag-dragging', model.get('scrubbing'));
            _updateStateClass();

            // player display
            switch (state) {
                case states.PLAYING:
                    _resizeMedia();
                    break;
                default:
                    break;
            }
        }

        function _dragging(model) {
            _stateHandler(model);
        }

        function createDisplayContainer() {
            var displayContainer = new DisplayContainer();
            var rewindDisplayIcon = new RewindDisplayIcon(_model, _api);
            var playDisplayIcon = createPlayDisplayIcon();
            var nextDisplayIcon = new NextDisplayIcon(_model, _api);

            displayContainer.addButton(rewindDisplayIcon);
            displayContainer.addButton(playDisplayIcon);
            displayContainer.addButton(nextDisplayIcon);

            return displayContainer.element();
        }

        function createPlayDisplayIcon() {
            var playDisplayIcon = new PlayDisplayIcon(_model);
            // toggle playback
            playDisplayIcon.on('click tap', function () {
                forward({ type: events.JWPLAYER_DISPLAY_CLICK });
                _controls.userActivity(1000);
                _api.play(reasonInteraction());
            });

            // make playDisplayIcon clickthrough on chrome for flash to avoid power safe throttle
            if (utils.isChrome() && !utils.isMobile()) {
                playDisplayIcon.el.addEventListener('mousedown', function () {
                    var provider = _model.getVideo();
                    var isFlash = (provider && provider.getName().name.indexOf('flash') === 0);

                    if (!isFlash) {
                        return;
                    }

                    var resetPointerEvents = function () {
                        document.removeEventListener('mouseup', resetPointerEvents);
                        playDisplayIcon.el.style.pointerEvents = 'auto';
                    };

                    this.style.pointerEvents = 'none';
                    document.addEventListener('mouseup', resetPointerEvents);
                });
            }

            return playDisplayIcon;
        }

        function _visibilityChangeListener() {
            _model.set('activeTab', activeTab());
        }

        this.setupInstream = function (instreamModel) {
            this.instreamModel = _instreamModel = instreamModel;
            _instreamModel.on('change:controls', _onChangeControls, this);
            _instreamModel.on('change:state', _stateHandler, this);

            utils.addClass(_playerElement, 'jw-flag-ads');

            // Call Controls.userActivity to display the UI temporarily for the start of the ad
            _controls.userActivity();
        };

        this.setAltText = function (text) {
            if (_controls) {
                _controls.controlbar.setAltText(text);
            }
        };

        this.destroyInstream = function () {
            if (_instreamModel) {
                _instreamModel.off(null, null, this);
                _instreamModel = null;
            }
            this.setAltText('');
            utils.removeClass(_playerElement, ['jw-flag-ads', 'jw-flag-ads-hide-controls']);
            _model.set('hideAdsControls', false);
            if (_model.getVideo) {
                var provider = _model.getVideo();
                provider.setContainer(_videoLayer);
            }
            _setLiveMode(_model, _model.get('duration'));
            // reset display click handler
            _controls.displayClick.revertAlternateClickHandlers();
        };

        this.addCues = function (cues) {
            if (_controls) {
                _controls.controlbar.addCues(cues);
            }
        };

        this.clickHandler = function () {
            return _controls.displayClick;
        };

        this.controlsContainer = function () {
            return _controlsLayer;
        };

        this.getContainer = this.element = function () {
            return _playerElement;
        };

        this.getSafeRegion = function (includeCB) {
            var bounds = {
                x: 0,
                y: 0,
                width: _lastWidth || 0,
                height: _lastHeight || 0
            };

            var controls = _model.get('controls');
            if (controls) {
                // If we are using a dock, subtract that from the top
                var dockButtons = _model.get('dock');
                if (dockButtons && dockButtons.length) {
                    bounds.y = _dock.element().clientHeight;
                    bounds.height -= bounds.y;
                }

                // Subtract controlbar from the bottom when using one
                includeCB = includeCB || !utils.exists(includeCB);
                if (includeCB && _controls) {
                    bounds.height -= _controls.controlbar.element().clientHeight;
                }
            }

            return bounds;
        };

        this.setCaptions = function (captionsStyle) {
            _captionsRenderer.clear();
            _captionsRenderer.setup(_model.get('id'), captionsStyle);
            _captionsRenderer.resize();
        };

        this.destroy = function () {
            this.off();
            _cancelDelayResize(_previewDisplayStateTimeout);
            clearTimeout(_resizeMediaTimeout);
            window.removeEventListener('resize', _responsiveListener);
            window.removeEventListener('orientationchange', _responsiveListener);
            document.removeEventListener('visibilitychange', _visibilityChangeListener);
            for (var i = DOCUMENT_FULLSCREEN_EVENTS.length; i--;) {
                document.removeEventListener(DOCUMENT_FULLSCREEN_EVENTS[i], _fullscreenChangeHandler, false);
            }
            if (_model.mediaController) {
                _model.mediaController.off('fullscreenchange', _fullscreenChangeHandler);
            }
            if (_controls) {
                _controls.disable();
            }
            _playerElement.removeEventListener('keydown', handleKeydown, false);
            if (_rightClickMenu) {
                _rightClickMenu.destroy();
            }
            if (_castDisplay) {
                _model.off('change:state', _castDisplay.statusDelegate);
                _castDisplay.destroy();
                _castDisplay = null;
            }
            if (_instreamModel) {
                this.destroyInstream();
            }
            if (_logo) {
                _logo.destroy();
            }
            utils.clearCss(_model.get('id'));
        };
    };
});
