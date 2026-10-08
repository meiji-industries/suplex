//! System notifications through UNUserNotificationCenter. A click runs that notification's callback.
//! Without notification permission nothing appears, and the menu action still reaches the pending state.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, Once,
    },
};

use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, runtime::Bool, AllocAnyThread};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

type Clicked = Box<dyn FnOnce() + Send>;

static CLICKS: Mutex<Option<HashMap<String, Clicked>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);
static DELEGATE: Once = Once::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "SuplexNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Show the banner while Suplex is the front app too.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let identifier = response.notification().request().identifier().to_string();
            let clicked = CLICKS
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|clicks| clicks.remove(&identifier));
            if let Some(clicked) = clicked {
                clicked();
            }
            completion.call(());
        }
    }
);

fn describe(error: *mut NSError) -> Option<String> {
    // SAFETY: the notification center passes a valid error or null.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

/// Posts a notification; `clicked` runs when the viewer clicks it.
pub fn post(title: &str, message: &str, clicked: impl FnOnce() + Send + 'static) {
    // The notification center belongs to an application bundle; a bare development binary has none.
    let bundled = std::env::current_exe()
        .is_ok_and(|path| path.to_string_lossy().contains(".app/Contents/MacOS/"));
    if !bundled {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    DELEGATE.call_once(|| {
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        center.setDelegate(Some(objc2::runtime::ProtocolObject::from_ref(&*delegate)));
        // The center keeps a weak reference; the delegate lives for the whole run.
        std::mem::forget(delegate);
    });
    let identifier = format!("suplex-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    CLICKS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(identifier.clone(), Box::new(clicked));
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(message));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&identifier),
        &content,
        None,
    );
    let poster = center.clone();
    // macOS asks the viewer once; later calls answer with the saved choice.
    let granted = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !granted.as_bool() {
            eprintln!(
                "Suplex cannot show notifications: {}",
                describe(error).unwrap_or_else(|| "permission was not given".into())
            );
            return;
        }
        let failed = RcBlock::new(|error: *mut NSError| {
            if let Some(reason) = describe(error) {
                eprintln!("Suplex could not post a notification: {reason}");
            }
        });
        poster.addNotificationRequest_withCompletionHandler(&request, Some(&failed));
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &granted,
    );
}
